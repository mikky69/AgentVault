import { useEffect, useRef, useState } from "react";
import { AGENT_ADDRESS, TOKEN_DECIMALS } from "./config";
import { AgentStatus, Counterparty, fetchAgentStatus, fetchCounterparties, submitDemoSpend } from "./api";
import logo from "./assets/AgentVault.png";

const POLL_MS = 3000;

// Flat, muted palette. No gradients, no glow — solid colors only.
const C = {
  bg: "#0B0D12",
  panel: "#12141B",
  border: "rgba(255,255,255,0.08)",
  dim: "#6B7280",
  text: "#B8BFCC",
  bright: "#EDEFF3",
  accent: "#4C8DFF",
  settled: "#34D399",
  pending: "#F5A623",
  error: "#F0596B",
};

const sans = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function statusStyles(status: string): { bg: string; text: string; display: string } {
  switch (status) {
    case "settled":
      return { bg: "rgba(52,211,153,0.12)", text: C.settled, display: "Settled" };
    case "cross_chain_unsupported":
      return { bg: "rgba(245,166,35,0.12)", text: C.pending, display: "Needs manual bridge" };
    case "unresolved_counterparty":
      return { bg: "rgba(245,166,35,0.12)", text: C.pending, display: "Unresolved" };
    default:
      return { bg: "rgba(240,89,107,0.12)", text: C.error, display: "Failed" };
  }
}

function formatAmount(smallestUnit: string): string {
  const value = Number(BigInt(smallestUnit)) / 10 ** TOKEN_DECIMALS;
  return value.toFixed(2);
}

function toSmallestUnit(decimalAmount: string): string {
  const value = Math.round(parseFloat(decimalAmount) * 10 ** TOKEN_DECIMALS);
  return value.toString();
}

function capPercent(spent: bigint, cap: bigint): number {
  if (cap <= 0n) return 0;
  return Math.min(100, Number((spent * 100n) / cap));
}

interface ConsoleLine {
  text: string;
  color?: string;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 11, fontFamily: sans, color: C.dim, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = statusStyles(status);
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: sans,
        fontWeight: 500,
        color: s.text,
        background: s.bg,
        borderRadius: 999,
        padding: "3px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {s.display}
    </span>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${percent}%`, borderRadius: 999, background: C.accent, transition: "width 0.4s ease" }} />
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!AGENT_ADDRESS) return;

    let cancelled = false;
    async function poll() {
      try {
        const [statusRes, cpRes] = await Promise.all([fetchAgentStatus(AGENT_ADDRESS), fetchCounterparties()]);
        if (cancelled) return;
        setStatus(statusRes);
        setCounterparties(cpRes.entries);
        setFetchError(null);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to reach backend");
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function counterpartyLabel(counterpartyId: string, fallbackLabel?: string): string {
    const match = counterparties.find((c) => c.id === counterpartyId);
    return match?.label ?? match?.identifier ?? fallbackLabel ?? counterpartyId.slice(0, 10) + "…";
  }

  async function handleCommand(raw: string) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") return;

    if (parts[0] !== "spend" || parts.length !== 3) {
      setConsoleLines([{ text: "usage: spend <counterparty> <amount>", color: C.error }]);
      return;
    }

    const [, identifier, amountStr] = parts;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      setConsoleLines([{ text: "amount must be a positive number", color: C.error }]);
      return;
    }

    setConsoleLines([{ text: "Submitting spend on-chain…", color: C.dim }]);
    try {
      const result = await submitDemoSpend(identifier, toSmallestUnit(amountStr));
      setConsoleLines([{ text: `Submitted — tx ${result.txHash.slice(0, 10)}… awaiting settlement`, color: C.settled }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Spend failed";
      setConsoleLines([{ text: msg, color: C.error }]);
    }
  }

  const spentToday = status ? BigInt(status.dailyCap) - BigInt(status.remainingDailyAllowance) : 0n;
  const cap = status ? BigInt(status.dailyCap) : 0n;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "40px 20px", fontFamily: sans }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* Wordmark header — outside the card, like a page title */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <img src={logo} alt="AgentVault" style={{ height: 28, width: "auto", display: "block" }} />
          <div style={{ fontSize: 12, color: C.dim }}>agent monitor</div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          {!AGENT_ADDRESS && (
            <div style={{ fontSize: 13, color: C.pending }}>
              No agent configured. Set VITE_AGENT_ADDRESS in dashboard/.env and restart the dev server.
            </div>
          )}

          {AGENT_ADDRESS && fetchError && (
            <div style={{ fontSize: 13, color: C.error }}>{fetchError} — waiting to reconnect…</div>
          )}

          {AGENT_ADDRESS && !fetchError && !status && (
            <div style={{ fontSize: 13, color: C.dim }}>Loading agent state…</div>
          )}

          {status && (
            <>
              {/* Identity row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
                <div>
                  <div style={{ fontSize: 11, color: C.dim, marginBottom: 4 }}>AGENT</div>
                  <div style={{ fontSize: 14, fontFamily: mono, color: C.bright }}>
                    {status.agent.slice(0, 6)}…{status.agent.slice(-4)}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: C.settled,
                    background: "rgba(52,211,153,0.12)",
                    borderRadius: 999,
                    padding: "4px 12px",
                  }}
                >
                  Active
                </span>
              </div>

              <div style={{ borderTop: `1px solid ${C.border}`, margin: "0 0 24px" }} />

              {/* Daily cap */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                  <SectionLabel>Daily Cap</SectionLabel>
                  <div style={{ fontSize: 13, fontFamily: mono, color: C.text }}>
                    {formatAmount(spentToday.toString())} / {formatAmount(cap.toString())} USDC
                  </div>
                </div>
                <ProgressBar percent={capPercent(spentToday, cap)} />
              </div>

              {/* Treasury balance */}
              <div style={{ marginBottom: 28 }}>
                <SectionLabel>Treasury Balance</SectionLabel>
                <div style={{ fontSize: 26, fontFamily: mono, color: C.bright, fontWeight: 600 }}>
                  {formatAmount(status.balance)} <span style={{ fontSize: 14, color: C.dim, fontWeight: 400 }}>USDC</span>
                </div>
              </div>

              {/* Counterparties */}
              <div style={{ marginBottom: 28 }}>
                <SectionLabel>Allowed Counterparties</SectionLabel>
                {counterparties.length === 0 ? (
                  <div style={{ fontSize: 13, color: C.dim }}>None registered yet</div>
                ) : (
                  <div>
                    {counterparties.map((c, i) => (
                      <div
                        key={c.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "10px 0",
                          borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                          fontSize: 13,
                        }}
                      >
                        <span style={{ color: C.text }}>{c.identifier}</span>
                        <span style={{ color: C.dim, fontFamily: mono, fontSize: 12 }}>
                          {c.moovePaymentLinkId.slice(0, 16)}…
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Activity */}
              <div>
                <SectionLabel>Activity</SectionLabel>
                {status.history.length === 0 ? (
                  <div style={{ fontSize: 13, color: C.dim }}>Waiting for events…</div>
                ) : (
                  <div>
                    {status.history.slice(0, 12).map((entry, i) => (
                      <div
                        key={entry.requestId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 0",
                          borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontSize: 13, color: C.bright }}>
                            {formatAmount(entry.amount)} USDC → {counterpartyLabel(entry.counterpartyId, entry.counterpartyLabel)}
                          </span>
                          <span style={{ fontSize: 11, color: C.dim, fontFamily: mono }}>
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <StatusPill status={entry.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Command line */}
        <div
          style={{
            marginTop: 16,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "12px 16px",
          }}
        >
          {consoleLines.map((line, i) => (
            <div key={i} style={{ fontSize: 12, color: line.color ?? C.text, marginBottom: 8, fontFamily: sans }}>
              {line.text}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.accent, fontFamily: mono, fontSize: 13 }}>›</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCommand(command);
                  setCommand("");
                }
              }}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: C.bright,
                fontFamily: mono,
                fontSize: 13,
              }}
              placeholder="spend provider-a 10"
              spellCheck={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
