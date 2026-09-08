export interface AuditEntry {
  agent: string;
  counterpartyId: string;
  counterpartyLabel?: string;
  amount: string;
  requestId: string;
  status: "settled" | "settlement_failed" | "unresolved_counterparty";
  mooveSettlementId?: string;
  txHash?: string;
  timestamp: number;
}

// MVP storage: in-memory array. Swap for a real DB before this needs to
// survive a restart or scale past a single process.
const auditLog: AuditEntry[] = [];

export function recordAuditEntry(entry: Omit<AuditEntry, "timestamp">) {
  auditLog.push({ ...entry, timestamp: Date.now() });
}

export function getAuditLog(agentAddress?: string): AuditEntry[] {
  const entries = agentAddress ? auditLog.filter((e) => e.agent.toLowerCase() === agentAddress.toLowerCase()) : auditLog;
  return [...entries].sort((a, b) => b.timestamp - a.timestamp);
}
