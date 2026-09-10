import { Contract, Wallet, JsonRpcProvider, isAddress } from "ethers";

/**
 * AgentVault currently supports direct settlement only when the payment
 * link's destination uses the treasury's exact token and chain. Cross-chain
 * and cross-token routing must use an authenticated Moove integration once
 * its server-to-server settlement contract is available and audited here.
 */

const MOOVE_API_BASE_URL = "https://api.moove.xyz";

// The asset actually leaving AgentTreasury — what we compare a payment
// link's requested token/chain against to decide if we can pay it directly.
const OUR_TOKEN_ADDRESS = process.env.SETTLEMENT_TOKEN_ADDRESS?.toLowerCase();
const OUR_CHAIN_ID = process.env.SETTLEMENT_CHAIN_ID; // e.g. "8453" for Base mainnet
const RELAYER_RPC_URL = process.env.SETTLEMENT_RPC_URL; // RPC for OUR_CHAIN_ID, not necessarily Base Sepolia
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;

const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

export interface MoovePaymentLink {
  id: string;
  destinationAddress: string;
  toAmount: string;
  receivedAmount: string | null;
  status: "active" | "completed" | "inactive";
  token: {
    address: string;
    decimals: number;
    symbol: string;
    chain: { id: string; name: string };
  };
}

export interface SettleParams {
  paymentLinkId: string;
  amount: bigint; // smallest unit of OUR settlement token
  requestId: string; // same idempotency key as the on-chain spend()
}

export type SettleStatus = "settled" | "cross_chain_unsupported" | "link_not_found" | "error";

export interface SettleResult {
  ok: boolean;
  status: SettleStatus;
  txHash?: string;
  raw?: unknown;
}

/** Public endpoint — no API key needed. This is deliberate on Moove's side: the hosted checkout page calls it unauthenticated. */
export async function fetchPaymentLink(linkId: string): Promise<MoovePaymentLink | undefined> {
  const res = await fetch(`${MOOVE_API_BASE_URL}/v1/payment-link/${linkId}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Moove payment-link lookup failed: ${res.status}`);
  return res.json() as Promise<MoovePaymentLink>;
}

/** Accepts either a bare link id or a full checkout URL and returns the id. */
export function extractPaymentLinkId(idOrUrl: string): string {
  const match = idOrUrl.match(/\/pay\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : idOrUrl;
}

let relayerWallet: Wallet | undefined;
export async function validateSettlementConfiguration(): Promise<void> {
  if (!OUR_TOKEN_ADDRESS || !isAddress(OUR_TOKEN_ADDRESS)) {
    throw new Error("SETTLEMENT_TOKEN_ADDRESS must be a valid EVM token address.");
  }
  if (!OUR_CHAIN_ID || !/^\d+$/.test(OUR_CHAIN_ID)) {
    throw new Error("SETTLEMENT_CHAIN_ID must be a numeric chain id.");
  }
  if (!RELAYER_RPC_URL || !RELAYER_PRIVATE_KEY) {
    throw new Error("SETTLEMENT_RPC_URL and RELAYER_PRIVATE_KEY must be set to execute settlement.");
  }
  const network = await new JsonRpcProvider(RELAYER_RPC_URL).getNetwork();
  if (network.chainId !== BigInt(OUR_CHAIN_ID)) {
    throw new Error(`Settlement RPC chain id ${network.chainId} does not match SETTLEMENT_CHAIN_ID ${OUR_CHAIN_ID}.`);
  }
}

function getRelayerWallet(): Wallet {
  if (!RELAYER_RPC_URL || !RELAYER_PRIVATE_KEY) {
    throw new Error("SETTLEMENT_RPC_URL and RELAYER_PRIVATE_KEY must be set to execute a live settlement.");
  }
  if (!relayerWallet) {
    relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, new JsonRpcProvider(RELAYER_RPC_URL));
  }
  return relayerWallet;
}

export async function settle(params: SettleParams): Promise<SettleResult> {
  await validateSettlementConfiguration();
  const link = await fetchPaymentLink(params.paymentLinkId);

  if (!link) {
    console.error(`[mooveClient] No payment link found for id ${params.paymentLinkId}`);
    return { ok: false, status: "link_not_found" };
  }

  const sameToken = link.token.address.toLowerCase() === OUR_TOKEN_ADDRESS;
  const sameChain = link.token.chain.id === OUR_CHAIN_ID;

  if (!sameToken || !sameChain) {
    // The honest branch. Moove Send/Swap/Bridge don't exist yet, so there's
    // no automated way to deliver a different asset/chain to this link.
    console.warn(
      `[mooveClient] Cannot auto-settle payment link ${link.id} — it wants ` +
        `${link.token.symbol} on chain ${link.token.chain.id}, treasury holds ` +
        `a different asset/chain. Needs Moove Send/Swap (not yet live) or manual handling.`
    );
    return { ok: false, status: "cross_chain_unsupported", raw: link };
  }

  const wallet = getRelayerWallet();
  const token = new Contract(link.token.address, ERC20_TRANSFER_ABI, wallet);
  const tx = await token.transfer(link.destinationAddress, params.amount);
  const receipt = await tx.wait();

  return { ok: true, status: "settled", txHash: receipt?.hash ?? tx.hash };
}
