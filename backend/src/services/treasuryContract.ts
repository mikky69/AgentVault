import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, isAddress, getAddress } from "ethers";
import { activateCounterparty, counterpartyIdFor, resolveCounterparty, stageCounterparty } from "./counterpartyRegistry.js";
import { getCheckpoint, getDueSpends, markSpendProcessing, markSpendResult, recordSpendEvent, setCheckpoint } from "./auditLog.js";
import { settle } from "./mooveClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const treasuryArtifact = JSON.parse(readFileSync(path.join(__dirname, "../abi/AgentTreasury.json"), "utf8"));
const abi = Array.isArray(treasuryArtifact) ? treasuryArtifact : treasuryArtifact.abi;

if (!Array.isArray(abi)) throw new Error("AgentTreasury ABI is missing or invalid.");

const RPC_URL = process.env.EVM_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL;
const TREASURY_ADDRESS = process.env.AGENT_TREASURY_ADDRESS;
const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY;
const EVENT_CONFIRMATIONS = Number(process.env.EVENT_CONFIRMATIONS ?? 3);
const EVENT_POLL_INTERVAL_MS = Number(process.env.EVENT_POLL_INTERVAL_MS ?? 12_000);
const CONTRACT_DEPLOYMENT_BLOCK = Number(process.env.CONTRACT_DEPLOYMENT_BLOCK ?? 0);
const EXPECTED_CHAIN_ID = Number(process.env.CHAIN_ID ?? 0);
const CHECKPOINT_CONSUMER = "agent-treasury-spend-listener-v1";

let provider: JsonRpcProvider | undefined;
let readContract: Contract | undefined;
let adminContract: Contract | undefined;
let syncing = false;

function requireConfigured(): { provider: JsonRpcProvider; readContract: Contract } {
  if (!RPC_URL || !TREASURY_ADDRESS) {
    throw new Error("EVM_RPC_URL and AGENT_TREASURY_ADDRESS must be set before the treasury contract can be reached.");
  }
  if (!isAddress(TREASURY_ADDRESS)) throw new Error("AGENT_TREASURY_ADDRESS is not a valid EVM address.");
  if (!provider) provider = new JsonRpcProvider(RPC_URL);
  if (!readContract) readContract = new Contract(getAddress(TREASURY_ADDRESS), abi, provider);
  return { provider, readContract };
}

function getAdminContract(): Contract {
  const { provider } = requireConfigured();
  if (!OWNER_PRIVATE_KEY) throw new Error("OWNER_PRIVATE_KEY must be set to perform admin actions.");
  if (!adminContract) adminContract = new Contract(getAddress(TREASURY_ADDRESS as string), abi, new Wallet(OWNER_PRIVATE_KEY, provider));
  return adminContract;
}

export function requireAgentAddress(address: string): string {
  if (!isAddress(address)) throw new Error("agent address must be a valid EVM address");
  return getAddress(address);
}

export async function setAgentPolicy(agentAddress: string, dailyCapSmallestUnit: bigint) {
  if (dailyCapSmallestUnit <= 0n) throw new Error("dailyCap must be greater than zero");
  const tx = await getAdminContract().setPolicy(requireAgentAddress(agentAddress), dailyCapSmallestUnit);
  return tx.wait();
}

export async function allowCounterparty(
  agentAddress: string,
  identifier: string,
  moovePaymentLinkId: string,
  label?: string
) {
  const agent = requireAgentAddress(agentAddress);
  const id = await stageCounterparty(agent, { identifier, moovePaymentLinkId, label });
  const tx = await getAdminContract().setCounterpartyAllowed(agent, id, true);
  await tx.wait();
  await activateCounterparty(agent, id);
  return { counterpartyId: id };
}

export async function getAgentStatus(agentAddress: string) {
  const agent = requireAgentAddress(agentAddress);
  const { readContract } = requireConfigured();
  const [balance, remainingDailyAllowance, policy] = await Promise.all([
    readContract.balanceOf(agent),
    readContract.remainingDailyAllowance(agent),
    readContract.policies(agent),
  ]);
  return {
    agent,
    balance: balance.toString(),
    remainingDailyAllowance: remainingDailyAllowance.toString(),
    dailyCap: policy.exists ? policy[0].toString() : "0",
  };
}

export async function submitDemoSpend(agentPrivateKey: string, counterpartyIdentifier: string, amountSmallestUnit: bigint) {
  if (amountSmallestUnit <= 0n) throw new Error("amount must be greater than zero");
  const { provider } = requireConfigured();
  const wallet = new Wallet(agentPrivateKey, provider);
  const contract = new Contract(getAddress(TREASURY_ADDRESS as string), abi, wallet);
  const counterpartyId = counterpartyIdFor(counterpartyIdentifier);
  const requestId = counterpartyIdFor(`${counterpartyIdentifier}:${Date.now()}:${crypto.randomUUID()}`);
  const tx = await contract.spend(counterpartyId, amountSmallestUnit, requestId);
  const receipt = await tx.wait();
  return { txHash: receipt?.hash ?? tx.hash, requestId, agent: wallet.address };
}

async function processDueSpends(): Promise<void> {
  for (const spend of await getDueSpends()) {
    if (!await markSpendProcessing(spend.requestId)) continue;

    try {
      const counterparty = await resolveCounterparty(spend.agent, spend.counterpartyId);
      if (!counterparty) {
        await markSpendResult(spend.requestId, "unresolved_counterparty", {
          errorMessage: "No active counterparty record exists for this agent and counterparty id.",
          retry: true,
        });
        continue;
      }

      const result = await settle({
        paymentLinkId: counterparty.moovePaymentLinkId,
        amount: BigInt(spend.amount),
        requestId: spend.requestId,
      });
      await markSpendResult(spend.requestId, result.status, {
        counterpartyLabel: counterparty.label ?? counterparty.identifier,
        settlementTxHash: result.txHash,
        errorMessage: result.ok ? undefined : result.status,
        retry: result.status === "link_not_found" || result.status === "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markSpendResult(spend.requestId, "error", { errorMessage: message, retry: true });
    }
  }
}

async function syncSpendEvents(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    if (!Number.isInteger(CONTRACT_DEPLOYMENT_BLOCK) || CONTRACT_DEPLOYMENT_BLOCK <= 0) {
      throw new Error("CONTRACT_DEPLOYMENT_BLOCK must be set to the deployment block for durable event indexing.");
    }
    const { provider, readContract } = requireConfigured();
    const latestBlock = await provider.getBlockNumber();
    const safeBlock = latestBlock - EVENT_CONFIRMATIONS;
    if (safeBlock < CONTRACT_DEPLOYMENT_BLOCK) return;

    const checkpoint = await getCheckpoint(CHECKPOINT_CONSUMER);
    const fromBlock = checkpoint === undefined ? CONTRACT_DEPLOYMENT_BLOCK : checkpoint + 1;
    if (fromBlock <= safeBlock) {
      const logs = await readContract.queryFilter(readContract.filters.SpendExecuted(), fromBlock, safeBlock);
      for (const log of logs) {
        const parsed = readContract.interface.parseLog(log);
        if (!parsed) continue;
        await recordSpendEvent({
          requestId: String(parsed.args.requestId),
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          agent: String(parsed.args.agent),
          counterpartyId: String(parsed.args.counterpartyId),
          amount: String(parsed.args.amount),
        });
      }
      await setCheckpoint(CHECKPOINT_CONSUMER, safeBlock);
    }
    await processDueSpends();
  } finally {
    syncing = false;
  }
}

export async function startSpendListener(): Promise<void> {
  const { provider } = requireConfigured();
  const network = await provider.getNetwork();
  if (!Number.isInteger(EXPECTED_CHAIN_ID) || EXPECTED_CHAIN_ID <= 0) {
    throw new Error("CHAIN_ID must be set to the chain that hosts AgentTreasury.");
  }
  if (network.chainId !== BigInt(EXPECTED_CHAIN_ID)) {
    throw new Error(`RPC chain id ${network.chainId} does not match configured CHAIN_ID ${EXPECTED_CHAIN_ID}.`);
  }
  await syncSpendEvents();
  setInterval(() => {
    void syncSpendEvents().catch((error) => console.error("[spendListener] sync failed", error));
  }, EVENT_POLL_INTERVAL_MS).unref();
  console.log("[spendListener] Indexing confirmed SpendExecuted events from Postgres checkpoint.");
}
