import { id as keccakId } from "ethers";

/**
 * The contract only ever sees keccak256(identifier) — it has no idea who
 * "provider-a" actually is. This registry is the off-chain preimage store:
 * it's what lets the backend turn a SpendExecuted event's counterpartyId
 * back into an actual Moove destination to settle to.
 *
 * MVP storage: in-memory map. Swap for a real table (Postgres) once this
 * moves past the demo — the interface below won't need to change.
 */

export interface CounterpartyRecord {
  identifier: string;      // human-readable id, e.g. "provider-a"
  mooveHandle: string;     // destination Moove Handle to settle to
  label?: string;          // display name for the dashboard
}

const registry = new Map<string, CounterpartyRecord>(); // key: bytes32 id (hex string)

/** Same hashing scheme the contract expects for `counterpartyId`. */
export function counterpartyIdFor(identifier: string): string {
  return keccakId(identifier);
}

export function registerCounterparty(record: CounterpartyRecord): string {
  const id = counterpartyIdFor(record.identifier);
  registry.set(id, record);
  return id;
}

export function resolveCounterparty(id: string): CounterpartyRecord | undefined {
  return registry.get(id);
}

export function listCounterparties(): Array<CounterpartyRecord & { id: string }> {
  return Array.from(registry.entries()).map(([id, record]) => ({ id, ...record }));
}
