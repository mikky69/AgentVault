import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, EventLog } from "ethers";
import { registerCounterparty, resolveCounterparty, counterpartyIdFor } from "./counterpartyRegistry.js";
import { settle } from "./mooveClient.js";
import { recordAuditEntry } from "./auditLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(readFileSync(path.join(__dirname, "../abi/AgentTreasury.json"), "utf8"));

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const TREASURY_ADDRESS = process.env.AGENT_TREASURY_ADDRESS;
const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY; // admin key: setPolicy / setCounterpartyAllowed

let provider: JsonRpcProvider | undefined;
let readContract: Contract | undefined;
let adminContract: Contract | undefined;

function requireConfigured(): { provider: JsonRpcProvider; readContract: Contract } {
  if (!RPC_URL || !TREASURY_ADDRESS) {
    throw new Error(
      "BASE_SEPOLIA_RPC_URL and AGENT_TREASURY_ADDRESS must be set (see .env.example) " +
        "before the treasury contract can be reached."
    );
  }
  if (!provider) provider = new JsonRpcProvider(RPC_URL);
  if (!readContract) readContract = new Contract(TREASURY_ADDRESS, abi, provider);
  return { provider, readContract };
}

function getAdminContract(): Contract {
  const { provider } = requireConfigured();
  if (!OWNER_PRIVATE_KEY) {
    throw new Error("OWNER_PRIVATE_KEY must be set to perform admin actions (setPolicy, allow counterparty).");
  }
  if (!adminContract) {
    const wallet = new Wallet(OWNER_PRIVATE_KEY, provider);
    adminContract = new Contract(TREASURY_ADDRESS as string, abi, wallet);
  }
  return adminContract;
}

/** Sets an agent's daily cap on-chain. Amount is already in the token's smallest unit. */
export async function setAgentPolicy(agentAddress: string, dailyCapSmallestUnit: bigint) {
  const contract = getAdminContract();
  const tx = await contract.setPolicy(agentAddress, dailyCapSmallestUnit);
  return tx.wait();
}

/**
 * Allows a counterparty for an agent AND registers the identifier -> Moove
 * destination mapping locally, so a later SpendExecuted event for this id
 * can actually be resolved and settled.
 */
export async function allowCounterparty(
  agentAddress: string,
  identifier: string,
  moovePaymentLinkId: string,
  label?: string
) {
  const id = registerCounterparty({ identifier, moovePaymentLinkId, label });
  const contract = getAdminContract();
  const tx = await contract.setCounterpartyAllowed(agentAddress, id, true);
  await tx.wait();
  return { counterpartyId: id };
}

export async function getAgentStatus(agentAddress: string) {
  const { readContract } = requireConfigured();
  const [balance, remainingDailyAllowance, policy] = await Promise.all([
    readContract.balanceOf(agentAddress),
    readContract.remainingDailyAllowance(agentAddress),
    readContract.policies(agentAddress), // returns [dailyCap, exists]
  ]);
  return {
    agent: agentAddress,
    balance: balance.toString(),
    remainingDailyAllowance: remainingDailyAllowance.toString(),
    dailyCap: policy.exists ? policy[0].toString() : "0",
  };
}

/**
 * DEMO ONLY. Signs and submits spend() using a private key passed in at
 * call time (from DEMO_AGENT_PRIVATE_KEY, wired up by the demo route) —
 * this is what lets the dashboard's command line actually trigger a real
 * on-chain spend without a separate bot script running somewhere. This is
 * NOT how a real agent should work: a real agent holds its own key and
 * calls spend() itself. This function exists purely so the demo has
 * something to point a command at.
 */
export async function submitDemoSpend(
  agentPrivateKey: string,
  counterpartyIdentifier: string,
  amountSmallestUnit: bigint
) {
  const { provider } = requireConfigured();
  const wallet = new Wallet(agentPrivateKey, provider);
  const contract = new Contract(TREASURY_ADDRESS as string, abi, wallet);
  const counterpartyId = counterpartyIdFor(counterpartyIdentifier);
  const requestId = counterpartyIdFor(`${counterpartyIdentifier}:${Date.now()}:${Math.random()}`);
  const tx = await contract.spend(counterpartyId, amountSmallestUnit, requestId);
  const receipt = await tx.wait();
  return { txHash: receipt?.hash ?? tx.hash, requestId, agent: wallet.address };
}

/**
 * Subscribes to SpendExecuted and, for each one, resolves the counterparty
 * and calls Moove to actually deliver the funds. This is the bridge between
 * "on-chain authorization happened" and "money actually moved off-chain."
 */
export function startSpendListener() {
  const { readContract } = requireConfigured();

  readContract.on(
    "SpendExecuted",
    async (agent: string, counterpartyId: string, amount: bigint, requestId: string, day: bigint, event: EventLog) => {
      const counterparty = resolveCounterparty(counterpartyId);

      if (!counterparty) {
        console.error(
          `[spendListener] Unknown counterpartyId ${counterpartyId} for agent ${agent} — ` +
            `cannot settle. Was it registered via allowCounterparty()?`
        );
        recordAuditEntry({
          agent,
          counterpartyId,
          amount: amount.toString(),
          requestId,
          status: "unresolved_counterparty",
          txHash: event.transactionHash,
        });
        return;
      }

      const result = await settle({
        paymentLinkId: counterparty.moovePaymentLinkId,
        amount,
        requestId,
      });

      recordAuditEntry({
        agent,
        counterpartyId,
        counterpartyLabel: counterparty.label ?? counterparty.identifier,
        amount: amount.toString(),
        requestId,
        status: result.status,
        settlementTxHash: result.txHash,
        txHash: event.transactionHash,
      });
    }
  );

  console.log("[spendListener] Listening for SpendExecuted events...");
}

export { counterpartyIdFor };
