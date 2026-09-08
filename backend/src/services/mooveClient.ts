/**
 * Wraps Moove's settlement API. This is intentionally the ONLY file that
 * should know about Moove's actual request/response shape — everything
 * else in the backend calls settle() and doesn't care how it's implemented.
 *
 * STATUS: STUBBED. We don't have Moove's real API base URL / auth flow /
 * request schema wired in yet. Swap MOOVE_API_BASE_URL + the fetch call
 * below for the real thing once the Moove API docs/keys land — the
 * function signature is deliberately generic (destination handle, amount,
 * idempotency key) so callers won't need to change.
 */

export interface SettleParams {
  destinationMooveHandle: string;
  amount: bigint;          // smallest unit of the source token (e.g. USDC, 6 decimals)
  assetSymbol: string;     // e.g. "USDC" — what's leaving the treasury
  requestId: string;       // reuse the same idempotency key as the on-chain spend()
}

export interface SettleResult {
  ok: boolean;
  mooveSettlementId?: string;
  raw?: unknown;
}

const MOOVE_API_BASE_URL = process.env.MOOVE_API_BASE_URL;
const MOOVE_API_KEY = process.env.MOOVE_API_KEY;

export async function settle(params: SettleParams): Promise<SettleResult> {
  if (!MOOVE_API_BASE_URL || !MOOVE_API_KEY) {
    // Mocked path — lets the rest of the system be built/demoed before
    // real Moove credentials exist. Loud on purpose so it's never mistaken
    // for a real settlement in logs.
    console.warn(
      `[mooveClient] MOCK SETTLEMENT — no MOOVE_API_BASE_URL/MOOVE_API_KEY set. ` +
        `Would send ${params.amount} ${params.assetSymbol} to ${params.destinationMooveHandle} ` +
        `(requestId=${params.requestId})`
    );
    return { ok: true, mooveSettlementId: `mock_${params.requestId}` };
  }

  // TODO: replace with the real Moove settlement endpoint once documented.
  const res = await fetch(`${MOOVE_API_BASE_URL}/v1/settlements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MOOVE_API_KEY}`,
    },
    body: JSON.stringify({
      destination_handle: params.destinationMooveHandle,
      amount: params.amount.toString(),
      asset: params.assetSymbol,
      idempotency_key: params.requestId,
    }),
  });

  const raw = await res.json().catch(() => undefined);
  return { ok: res.ok, mooveSettlementId: (raw as any)?.id, raw };
}
