import { getDatabase } from "./database.js";

export type SpendStatus =
  | "pending"
  | "processing"
  | "settled"
  | "cross_chain_unsupported"
  | "link_not_found"
  | "unresolved_counterparty"
  | "error";

export interface AuditEntry {
  agent: string;
  counterpartyId: string;
  counterpartyLabel?: string;
  amount: string;
  requestId: string;
  status: SpendStatus;
  settlementTxHash?: string;
  txHash?: string;
  timestamp: number;
}

export interface SpendEventInput {
  requestId: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  agent: string;
  counterpartyId: string;
  amount: string;
}

export interface PendingSpend extends SpendEventInput {
  attemptCount: number;
}

function mapEntry(row: Record<string, unknown>): AuditEntry {
  return {
    agent: String(row.agent_address),
    counterpartyId: String(row.counterparty_id),
    counterpartyLabel: row.counterparty_label ? String(row.counterparty_label) : undefined,
    amount: String(row.amount),
    requestId: String(row.request_id),
    status: row.status as SpendStatus,
    settlementTxHash: row.settlement_tx_hash ? String(row.settlement_tx_hash) : undefined,
    txHash: row.transaction_hash ? String(row.transaction_hash) : undefined,
    timestamp: new Date(String(row.created_at)).getTime(),
  };
}

export async function recordSpendEvent(event: SpendEventInput): Promise<void> {
  await getDatabase().query(
    `insert into spend_events (
       request_id, transaction_hash, log_index, block_number, agent_address, counterparty_id, amount, status
     ) values ($1, $2, $3, $4, $5, $6, $7, 'pending')
     on conflict (request_id) do nothing`,
    [event.requestId, event.txHash, event.logIndex, event.blockNumber, event.agent.toLowerCase(), event.counterpartyId, event.amount]
  );
}

export async function getDueSpends(limit = 25): Promise<PendingSpend[]> {
  const result = await getDatabase().query<Record<string, unknown>>(
    `select request_id, transaction_hash, log_index, block_number, agent_address, counterparty_id, amount, attempt_count
     from spend_events
     where (status in ('pending', 'link_not_found', 'unresolved_counterparty') and next_attempt_at <= now())
        or (status = 'processing' and updated_at < now() - interval '5 minutes')
     order by block_number asc, log_index asc
     limit $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    requestId: String(row.request_id),
    txHash: String(row.transaction_hash),
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    agent: String(row.agent_address),
    counterpartyId: String(row.counterparty_id),
    amount: String(row.amount),
    attemptCount: Number(row.attempt_count),
  }));
}

export async function markSpendProcessing(requestId: string): Promise<boolean> {
  const result = await getDatabase().query(
    `update spend_events set status = 'processing', updated_at = now()
     where request_id = $1 and status in ('pending', 'link_not_found', 'unresolved_counterparty', 'processing')`,
    [requestId]
  );
  return result.rowCount === 1;
}

export async function markSpendResult(
  requestId: string,
  status: SpendStatus,
  options: { counterpartyLabel?: string; settlementTxHash?: string; errorMessage?: string; retry: boolean }
): Promise<void> {
  await getDatabase().query(
    `update spend_events set
       status = $2,
       counterparty_label = coalesce($3, counterparty_label),
       settlement_tx_hash = coalesce($4, settlement_tx_hash),
       error_message = $5,
       attempt_count = attempt_count + 1,
       next_attempt_at = case when $6 then now() + (least(3600, 30 * power(2, least(7, attempt_count))) * interval '1 second') else 'infinity'::timestamptz end,
       updated_at = now()
     where request_id = $1`,
    [requestId, status, options.counterpartyLabel ?? null, options.settlementTxHash ?? null, options.errorMessage ?? null, options.retry]
  );
}

export async function getAuditLog(agentAddress?: string): Promise<AuditEntry[]> {
  const result = await getDatabase().query<Record<string, unknown>>(
    `select request_id, transaction_hash, agent_address, counterparty_id, counterparty_label,
            amount, status, settlement_tx_hash, created_at
     from spend_events
     where ($1::text is null or agent_address = $1)
     order by created_at desc`,
    [agentAddress?.toLowerCase() ?? null]
  );
  return result.rows.map(mapEntry);
}

export async function getCheckpoint(consumer: string): Promise<number | undefined> {
  const result = await getDatabase().query<{ block_number: string }>(
    "select block_number from event_checkpoints where consumer = $1",
    [consumer]
  );
  return result.rows[0] ? Number(result.rows[0].block_number) : undefined;
}

export async function setCheckpoint(consumer: string, blockNumber: number): Promise<void> {
  await getDatabase().query(
    `insert into event_checkpoints (consumer, block_number) values ($1, $2)
     on conflict (consumer) do update set block_number = excluded.block_number, updated_at = now()`,
    [consumer, blockNumber]
  );
}
