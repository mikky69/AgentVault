import { Contract, Wallet, JsonRpcProvider } from "ethers";

/**
 * Moove's live API surface today is receive-only: you can create/list your
 * OWN payment links, and anyone can read a link's public data (including
 * its destinationAddress) with no auth at all. There is no Send, Swap, or
 * Bridge API yet — Moove's own docs list those as "coming soon." So there
 * is no endpoint AgentVault can call to say "pay this counterparty X" in
 * general.
 *
 * What IS real and live: if the counterparty's payment link happens to
 * settle in the exact same token, on the exact same chain, as what's
 * leaving our treasury, paying it is just an ERC20 transfer to the link's
 * destinationAddress — which is precisely what Moove's own checkout does
 * for a same-asset payer (and why that case is fee-free per their pricing
 * page). That's the only path this file automates for real.
 *
 * Anything else — a counterparty who wants a different token or chain —
 * has no live automated path today. We report that honestly
 * (`cross_chain_unsupported`) instead of pretending to settle it. The day
 * Moove Send/Swap ships, that branch is the only thing that needs to
 * change here.
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

  if (!process.env.SETTLEMENT_RPC_URL || !process.env.RELAYER_PRIVATE_KEY) {
    // Same asset/chain, but this deployment hasn't configured a relayer
    // wallet to actually move funds yet — surface that plainly rather than
    // silently no-op'ing.
    console.warn(
      `[mooveClient] MOCK SETTLEMENT — asset/chain match confirmed for link ${link.id}, ` +
        `but SETTLEMENT_RPC_URL/RELAYER_PRIVATE_KEY are not set. ` +
        `Would transfer ${params.amount} to ${link.destinationAddress}.`
    );
    return { ok: true, status: "settled", txHash: `mock_${params.requestId}` };
  }

  const wallet = getRelayerWallet();
  const token = new Contract(link.token.address, ERC20_TRANSFER_ABI, wallet);
  const tx = await token.transfer(link.destinationAddress, params.amount);
  const receipt = await tx.wait();

  return { ok: true, status: "settled", txHash: receipt?.hash ?? tx.hash };
}
