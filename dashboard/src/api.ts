import { BACKEND_URL } from "./config";

export interface AuditEntry {
  agent: string;
  counterpartyId: string;
  counterpartyLabel?: string;
  amount: string;
  requestId: string;
  status: "pending" | "processing" | "settled" | "cross_chain_unsupported" | "link_not_found" | "error" | "unresolved_counterparty";
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

interface AdminRequestOptions {
  method: "POST" | "DELETE";
  adminKey: string;
  body?: unknown;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function adminRequest<T>(path: string, options: AdminRequestOptions): Promise<T> {
  return fetch(`${BACKEND_URL}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.adminKey}`,
      "content-type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then((response) => asJson<T>(response));
}

export function fetchAgentStatus(agent: string): Promise<AgentStatus> {
  return fetch(`${BACKEND_URL}/agents/${agent}`).then((response) => asJson<AgentStatus>(response));
}

export function fetchCounterparties(agent: string): Promise<{ entries: Counterparty[] }> {
  return fetch(`${BACKEND_URL}/agents/${agent}/counterparties`).then((response) => asJson(response));
}

export function updateDailyCap(agent: string, dailyCap: string, adminKey: string): Promise<{ ok: true; txHash?: string }> {
  return adminRequest(`/agents/${agent}/policy`, { method: "POST", adminKey, body: { dailyCap } });
}

export function registerCounterparty(
  agent: string,
  input: { identifier: string; moovePaymentLinkId: string; label?: string },
  adminKey: string
): Promise<{ ok: true; counterpartyId: string }> {
  return adminRequest(`/agents/${agent}/counterparties`, { method: "POST", adminKey, body: input });
}

export function revokeCounterparty(agent: string, counterpartyId: string, adminKey: string): Promise<{ ok: true; txHash?: string }> {
  return adminRequest(`/agents/${agent}/counterparties/${counterpartyId}`, { method: "DELETE", adminKey });
}

export function submitDemoSpend(counterpartyIdentifier: string, amountSmallestUnit: string, adminKey: string) {
  return adminRequest<{ ok: true; txHash: string; requestId: string; agent: string }>("/demo/spend", {
    method: "POST",
    adminKey,
    body: { counterpartyIdentifier, amount: amountSmallestUnit },
  });
}
