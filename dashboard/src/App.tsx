import { FormEvent, useCallback, useEffect, useState } from "react";
import { AGENT_ADDRESS, ENABLE_DEMO_SPEND, TOKEN_DECIMALS } from "./config";
import {
  AgentStatus,
  Counterparty,
  fetchAgentStatus,
  fetchCounterparties,
  registerCounterparty,
  revokeCounterparty,
  submitDemoSpend,
  updateDailyCap,
} from "./api";
import logo from "./assets/AgentVault.png";

const POLL_MS = 12_000;
const C = {
  bg: "#0B0D12",
  panel: "#12141B",
  field: "#0D1016",
  border: "rgba(255,255,255,0.10)",
  dim: "#8A93A3",
  text: "#C8CFDA",
  bright: "#F4F6F9",
  accent: "#4C8DFF",
  settled: "#34D399",
  pending: "#F5A623",
  error: "#F0596B",
};
const sans = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  background: C.field,
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  color: C.bright,
  fontFamily: mono,
  fontSize: 13,
  outline: "none",
  padding: "10px 11px",
};
const buttonStyle = {
  background: C.accent,
  border: "none",
  borderRadius: 5,
  color: "#FFFFFF",
  cursor: "pointer",
  fontFamily: sans,
  fontSize: 13,
  fontWeight: 600,
  minHeight: 36,
  padding: "0 14px",
};

function statusStyles(status: string): { bg: string; text: string; display: string } {
  switch (status) {
    case "settled": return { bg: "rgba(52,211,153,0.12)", text: C.settled, display: "Settled" };
    case "pending":
    case "processing": return { bg: "rgba(76,141,255,0.12)", text: C.accent, display: "Settling" };
    case "cross_chain_unsupported": return { bg: "rgba(245,166,35,0.12)", text: C.pending, display: "Manual review" };
    case "unresolved_counterparty": return { bg: "rgba(245,166,35,0.12)", text: C.pending, display: "Unresolved" };
    default: return { bg: "rgba(240,89,107,0.12)", text: C.error, display: "Failed" };
  }
}

function formatAmount(value: string): string {
  const raw = BigInt(value);
  const base = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(TOKEN_DECIMALS, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${fraction}`;
}

function toSmallestUnit(value: string): string {
  const input = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(input) || Number(input) <= 0) throw new Error("Enter a positive USDC amount with no more than 6 decimals.");
  const [whole, fraction = ""] = input.split(".");
  return `${whole}${fraction.padEnd(TOKEN_DECIMALS, "0")}`.replace(/^0+(?=\d)/, "");
}

function capPercent(spent: bigint, cap: bigint): number {
  if (cap <= 0n) return 0;
  return Math.min(100, Number((spent * 100n) / cap));
}

function SectionLabel({ children }: { children: string }) {
  return <div style={{ color: C.dim, fontFamily: sans, fontSize: 11, letterSpacing: 1, marginBottom: 10, textTransform: "uppercase" }}>{children}</div>;
}

function StatusPill({ status }: { status: string }) {
  const style = statusStyles(status);
  return <span style={{ background: style.bg, borderRadius: 999, color: style.text, fontFamily: sans, fontSize: 11, fontWeight: 600, padding: "4px 9px", whiteSpace: "nowrap" }}>{style.display}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", minWidth: 0 }}><div style={{ color: C.dim, fontSize: 11, marginBottom: 6 }}>{label}</div>{children}</label>;
}

export default function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [label, setLabel] = useState("");
  const [paymentLink, setPaymentLink] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!AGENT_ADDRESS) return;
    try {
      const [agentStatus, counterpartiesResponse] = await Promise.all([
        fetchAgentStatus(AGENT_ADDRESS),
        fetchCounterparties(AGENT_ADDRESS),
      ]);
      setStatus(agentStatus);
      setCounterparties(counterpartiesResponse.entries);
      setFetchError(null);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to reach backend");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  function requireAdminKey(): string {
    if (!adminKey.trim()) throw new Error("Enter the operator API key to make an on-chain change.");
    return adminKey.trim();
  }

  async function handlePolicy(event: FormEvent) {
    event.preventDefault();
    setBusy("policy");
    setNotice(null);
    try {
      const result = await updateDailyCap(AGENT_ADDRESS, toSmallestUnit(dailyCap), requireAdminKey());
      setNotice({ text: `Policy updated${result.txHash ? `: ${result.txHash.slice(0, 10)}...` : ""}` });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Policy update failed", error: true });
    } finally {
      setBusy(null);
    }
  }

  async function handleCounterparty(event: FormEvent) {
    event.preventDefault();
    setBusy("counterparty");
    setNotice(null);
    try {
      const result = await registerCounterparty(AGENT_ADDRESS, {
        identifier: identifier.trim(),
        label: label.trim() || undefined,
        moovePaymentLinkId: paymentLink.trim(),
      }, requireAdminKey());
      setIdentifier("");
      setLabel("");
      setPaymentLink("");
      setNotice({ text: `Counterparty registered: ${result.counterpartyId.slice(0, 10)}...` });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Counterparty registration failed", error: true });
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke(counterparty: Counterparty) {
    setBusy(`revoke-${counterparty.id}`);
    setNotice(null);
    try {
      const result = await revokeCounterparty(AGENT_ADDRESS, counterparty.id, requireAdminKey());
      setNotice({ text: `Counterparty revoked${result.txHash ? `: ${result.txHash.slice(0, 10)}...` : ""}` });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Counterparty revocation failed", error: true });
    } finally {
      setBusy(null);
    }
  }

  async function handleDemoSpend(event: FormEvent) {
    event.preventDefault();
    const parts = command.trim().split(/\s+/);
    setBusy("demo");
    setNotice(null);
    try {
      if (parts.length !== 3 || parts[0] !== "spend") throw new Error("Use: spend <counterparty> <amount>");
      const result = await submitDemoSpend(parts[1], toSmallestUnit(parts[2]), requireAdminKey());
      setCommand("");
      setNotice({ text: `Spend submitted: ${result.txHash.slice(0, 10)}...` });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Spend failed", error: true });
    } finally {
      setBusy(null);
    }
  }

  const spentToday = status ? BigInt(status.dailyCap) - BigInt(status.remainingDailyAllowance) : 0n;
  const cap = status ? BigInt(status.dailyCap) : 0n;

  return (
    <main style={{ background: C.bg, color: C.text, fontFamily: sans, minHeight: "100vh", padding: "32px 20px" }}>
      <div style={{ margin: "0 auto", maxWidth: 940 }}>
        <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
          <img alt="AgentVault" src={logo} style={{ display: "block", height: 68, maxWidth: "70%", objectFit: "contain", width: "auto" }} />
          <span style={{ color: C.dim, fontSize: 12 }}>Treasury operations</span>
        </header>

        {!AGENT_ADDRESS && <div style={{ color: C.pending, fontSize: 13 }}>Set `VITE_AGENT_ADDRESS` to the managed agent wallet and restart the dashboard.</div>}
        {AGENT_ADDRESS && fetchError && <div style={{ color: C.error, fontSize: 13, marginBottom: 16 }}>{fetchError}</div>}

        {status && <>
          <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 24 }}>
            <div style={{ alignItems: "flex-start", display: "flex", gap: 24, justifyContent: "space-between", marginBottom: 24 }}>
              <div><SectionLabel>Managed Agent</SectionLabel><div style={{ color: C.bright, fontFamily: mono, fontSize: 14 }}>{status.agent}</div></div>
              <span style={{ background: "rgba(52,211,153,0.12)", borderRadius: 999, color: C.settled, fontSize: 11, fontWeight: 600, padding: "4px 9px" }}>Connected</span>
            </div>
            <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <div><SectionLabel>Treasury Balance</SectionLabel><div style={{ color: C.bright, fontFamily: mono, fontSize: 26, fontWeight: 600 }}>{formatAmount(status.balance)} <span style={{ color: C.dim, fontSize: 13, fontWeight: 400 }}>USDC</span></div></div>
              <div><SectionLabel>Daily Allowance</SectionLabel><div style={{ color: C.bright, fontFamily: mono, fontSize: 18 }}>{formatAmount(spentToday.toString())} <span style={{ color: C.dim }}>/</span> {formatAmount(cap.toString())} USDC</div><div style={{ background: "rgba(255,255,255,0.07)", height: 6, marginTop: 12, overflow: "hidden" }}><div style={{ background: C.accent, height: "100%", transition: "width .25s ease", width: `${capPercent(spentToday, cap)}%` }} /></div></div>
            </div>
          </section>

          <section style={{ borderBottom: `1px solid ${C.border}`, marginTop: 32, paddingBottom: 12 }}><SectionLabel>Operator Access</SectionLabel><Field label="Operator API key"><input aria-label="Operator API key" autoComplete="off" onChange={(event) => setAdminKey(event.target.value)} placeholder="Paste for this session" style={inputStyle} type="password" value={adminKey} /></Field></section>

          {notice && <div role="status" style={{ background: notice.error ? "rgba(240,89,107,0.10)" : "rgba(52,211,153,0.10)", border: `1px solid ${notice.error ? "rgba(240,89,107,0.3)" : "rgba(52,211,153,0.3)"}`, color: notice.error ? C.error : C.settled, fontFamily: mono, fontSize: 12, marginTop: 16, padding: "10px 12px" }}>{notice.text}</div>}

          <section style={{ display: "grid", gap: 28, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginTop: 28 }}>
            <form onSubmit={handlePolicy} style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
              <SectionLabel>Spend Policy</SectionLabel>
              <Field label="Daily cap (USDC)"><input inputMode="decimal" onChange={(event) => setDailyCap(event.target.value)} placeholder={formatAmount(status.dailyCap)} required style={inputStyle} value={dailyCap} /></Field>
              <button disabled={busy === "policy"} style={{ ...buttonStyle, marginTop: 12, opacity: busy === "policy" ? 0.6 : 1 }} type="submit">{busy === "policy" ? "Updating..." : "Update cap"}</button>
            </form>
            <form onSubmit={handleCounterparty} style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
              <SectionLabel>Register Counterparty</SectionLabel>
              <div style={{ display: "grid", gap: 10 }}>
                <Field label="Identifier"><input onChange={(event) => setIdentifier(event.target.value)} placeholder="provider-a" required style={inputStyle} value={identifier} /></Field>
                <Field label="Label"><input onChange={(event) => setLabel(event.target.value)} placeholder="Provider A" style={inputStyle} value={label} /></Field>
                <Field label="Moove payment link"><input onChange={(event) => setPaymentLink(event.target.value)} placeholder="https://www.moove.xyz/.../pay/..." required style={inputStyle} type="url" value={paymentLink} /></Field>
              </div>
              <button disabled={busy === "counterparty"} style={{ ...buttonStyle, marginTop: 12, opacity: busy === "counterparty" ? 0.6 : 1 }} type="submit">{busy === "counterparty" ? "Registering..." : "Register"}</button>
            </form>
          </section>

          <section style={{ borderTop: `1px solid ${C.border}`, marginTop: 32, paddingTop: 18 }}>
            <SectionLabel>Allowed Counterparties</SectionLabel>
            {counterparties.length === 0 ? <div style={{ color: C.dim, fontSize: 13 }}>No active counterparties.</div> : counterparties.map((counterparty) => <div key={counterparty.id} style={{ alignItems: "center", borderTop: `1px solid ${C.border}`, display: "flex", gap: 16, justifyContent: "space-between", padding: "12px 0" }}>
              <div style={{ minWidth: 0 }}><div style={{ color: C.bright, fontSize: 13 }}>{counterparty.label ?? counterparty.identifier}</div><div style={{ color: C.dim, fontFamily: mono, fontSize: 11, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{counterparty.identifier} · {counterparty.moovePaymentLinkId}</div></div>
              <button aria-label={`Revoke ${counterparty.identifier}`} disabled={busy === `revoke-${counterparty.id}`} onClick={() => void handleRevoke(counterparty)} style={{ background: "transparent", border: `1px solid rgba(240,89,107,0.45)`, borderRadius: 5, color: C.error, cursor: "pointer", fontSize: 12, minHeight: 32, padding: "0 10px" }} type="button">{busy === `revoke-${counterparty.id}` ? "Revoking..." : "Revoke"}</button>
            </div>)}
          </section>

          <section style={{ borderTop: `1px solid ${C.border}`, marginTop: 32, paddingTop: 18 }}>
            <SectionLabel>Settlement Activity</SectionLabel>
            {status.history.length === 0 ? <div style={{ color: C.dim, fontSize: 13 }}>No spend events indexed yet.</div> : status.history.slice(0, 12).map((entry) => <div key={entry.requestId} style={{ alignItems: "center", borderTop: `1px solid ${C.border}`, display: "flex", gap: 16, justifyContent: "space-between", padding: "12px 0" }}>
              <div><div style={{ color: C.bright, fontSize: 13 }}>{formatAmount(entry.amount)} USDC <span style={{ color: C.dim }}>to</span> {entry.counterpartyLabel ?? entry.counterpartyId.slice(0, 12)}</div><div style={{ color: C.dim, fontFamily: mono, fontSize: 11, marginTop: 3 }}>{new Date(entry.timestamp).toLocaleString()}</div></div><StatusPill status={entry.status} />
            </div>)}
          </section>
        </>}

        {ENABLE_DEMO_SPEND && <form onSubmit={handleDemoSpend} style={{ borderTop: `1px solid ${C.border}`, marginTop: 32, paddingTop: 16 }}><Field label="Demo spend"><input onChange={(event) => setCommand(event.target.value)} placeholder="spend provider-a 10" style={inputStyle} value={command} /></Field><button disabled={busy === "demo"} style={{ ...buttonStyle, marginTop: 12 }} type="submit">Submit demo spend</button></form>}
      </div>
    </main>
  );
}
