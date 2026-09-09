import { id as keccakId } from "ethers";
import { extractPaymentLinkId } from "./mooveClient.js";

/**
 * The contract only ever sees keccak256(identifier) — it has no idea who
 * "provider-a" actually is. This registry is the off-chain preimage store:
 * it's what lets the backend turn a SpendExecuted event's counterpartyId
 * back into an actual Moove destination to settle to.
 *
 * moovePaymentLinkId is a real Moove payment link the counterparty created
 * themselves (in their own Moove dashboard) representing "pay me here." We
 * store just the id — resolving it to an actual destination address/token/
 * chain happens at settlement time via the public payment-link lookup, so
 * this registry never goes stale even if the counterparty's default wallet
 * changes.
 *
 * MVP storage: in-memory map. Swap for a real table (Postgres) once this
 * moves past the demo — the interface below won't need to change.
 */

export interface CounterpartyRecord {
  identifier: string;         // human-readable id, e.g. "provider-a"
  moovePaymentLinkId: string; // the counterparty's own Moove payment link
  label?: string;             // display name for the dashboard
}

const registry = new Map<string, CounterpartyRecord>(); // key: bytes32 id (hex string)

/** Same hashing scheme the contract expects for `counterpartyId`. */
export function counterpartyIdFor(identifier: string): string {
  return keccakId(identifier);
}

export function registerCounterparty(record: CounterpartyRecord): string {
  const id = counterpartyIdFor(record.identifier);
  registry.set(id, { ...record, moovePaymentLinkId: extractPaymentLinkId(record.moovePaymentLinkId) });
  return id;
}

export function resolveCounterparty(id: string): CounterpartyRecord | undefined {
  return registry.get(id);
}

export function listCounterparties(): Array<CounterpartyRecord & { id: string }> {
  return Array.from(registry.entries()).map(([id, record]) => ({ id, ...record }));
}
