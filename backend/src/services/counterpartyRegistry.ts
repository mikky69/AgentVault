import { id as keccakId } from "ethers";
import { getDatabase } from "./database.js";
import { extractPaymentLinkId } from "./mooveClient.js";

export interface CounterpartyRecord {
  identifier: string;
  moovePaymentLinkId: string;
  label?: string;
}

export interface StoredCounterparty extends CounterpartyRecord {
  id: string;
  active: boolean;
}

export function counterpartyIdFor(identifier: string): string {
  return keccakId(identifier);
}

export async function stageCounterparty(agentAddress: string, record: CounterpartyRecord): Promise<string> {
  const id = counterpartyIdFor(record.identifier);
  await getDatabase().query(
    `insert into counterparties (
       agent_address, counterparty_id, identifier, moove_payment_link_id, label, active
     ) values ($1, $2, $3, $4, $5, false)
     on conflict (agent_address, counterparty_id) do update set
       identifier = excluded.identifier,
       moove_payment_link_id = excluded.moove_payment_link_id,
       label = excluded.label,
       active = false,
       updated_at = now()`,
    [agentAddress.toLowerCase(), id, record.identifier, extractPaymentLinkId(record.moovePaymentLinkId), record.label ?? null]
  );
  return id;
}

export async function activateCounterparty(agentAddress: string, counterpartyId: string): Promise<void> {
  await getDatabase().query(
    "update counterparties set active = true, updated_at = now() where agent_address = $1 and counterparty_id = $2",
    [agentAddress.toLowerCase(), counterpartyId]
  );
}

export async function deactivateCounterparty(agentAddress: string, counterpartyId: string): Promise<void> {
  await getDatabase().query(
    "update counterparties set active = false, updated_at = now() where agent_address = $1 and counterparty_id = $2",
    [agentAddress.toLowerCase(), counterpartyId]
  );
}

export async function resolveCounterparty(agentAddress: string, counterpartyId: string): Promise<CounterpartyRecord | undefined> {
  const result = await getDatabase().query<{
    identifier: string;
    moove_payment_link_id: string;
    label: string | null;
  }>(
    `select identifier, moove_payment_link_id, label
     from counterparties
     where agent_address = $1 and counterparty_id = $2 and active = true`,
    [agentAddress.toLowerCase(), counterpartyId]
  );
  const row = result.rows[0];
  return row && {
    identifier: row.identifier,
    moovePaymentLinkId: row.moove_payment_link_id,
    label: row.label ?? undefined,
  };
}

export async function listCounterparties(agentAddress: string): Promise<StoredCounterparty[]> {
  const result = await getDatabase().query<{
    counterparty_id: string;
    identifier: string;
    moove_payment_link_id: string;
    label: string | null;
    active: boolean;
  }>(
    `select counterparty_id, identifier, moove_payment_link_id, label, active
     from counterparties where agent_address = $1 and active = true order by created_at asc`,
    [agentAddress.toLowerCase()]
  );
  return result.rows.map((row) => ({
    id: row.counterparty_id,
    identifier: row.identifier,
    moovePaymentLinkId: row.moove_payment_link_id,
    label: row.label ?? undefined,
    active: row.active,
  }));
}
