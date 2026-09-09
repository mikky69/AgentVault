import { BACKEND_URL } from "./config";

export interface AuditEntry {
  agent: string;
  counterpartyId: string;
  counterpartyLabel?: string;
  amount: string;
  requestId: string;
  status: "settled" | "cross_chain_unsupported" | "link_not_found" | "error" | "unresolved_counterparty";
  settlementTxHash?: string;
  txHash?: string;
  timestamp: number;
}

export interface AgentStatus {
  agent: string;
  balance: string;
  remainingDailyAllowance: string;
  dailyCap: string;
  history: AuditEntry[];
}

export interface Counterparty {
  id: string;
  identifier: string;
  moovePaymentLinkId: string;
  label?: string;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchAgentStatus(agent: string): Promise<AgentStatus> {
  return fetch(`${BACKEND_URL}/agents/${agent}`).then((r) => asJson<AgentStatus>(r));
}

export function fetchCounterparties(): Promise<{ entries: Counterparty[] }> {
  return fetch(`${BACKEND_URL}/counterparties`).then((r) => asJson(r));
}

export function submitDemoSpend(counterpartyIdentifier: string, amountSmallestUnit: string) {
  return fetch(`${BACKEND_URL}/demo/spend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ counterpartyIdentifier, amount: amountSmallestUnit }),
  }).then((r) => asJson<{ ok: true; txHash: string; requestId: string; agent: string }>(r));
}
