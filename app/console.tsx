"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SimulationReport,
  ExecutionReport,
  RollbackReport,
  Consequences,
} from "@/lib/gateway";
import { money } from "@/lib/policy/invariants";
import { PRESETS } from "@/lib/presets";
import { Badge, Diff, Evidence, Invariants, Rollback, Verdict } from "./report";

type Phase =
  | "boot"
  | "provisioning"
  | "idle"
  | "planning"
  | "simulating"
  | "reviewing"
  | "approved"
  | "executing"
  | "executed"
  | "rollingback";

type Grant = { approvalId: string; token: string; expiresAt: string };

type State = {
  provisioned: boolean;
  tenantId?: string;
  stripe: boolean;
  gemini: boolean;
  totals?: { orders: number; captured: number; refunded: number };
};

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `${url} failed`);
  return json as T;
}

/** Remedies that add exclusions should accumulate, not replace one another. */
function mergePatch(
  params: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...params, ...patch };
  for (const key of ["excludeOrderIds", "excludeCustomerIds"]) {
    if (Array.isArray(patch[key]) && Array.isArray(params[key])) {
      out[key] = [...new Set([...(params[key] as string[]), ...(patch[key] as string[])])];
    }
  }
  return out;
}

export default function Console() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [state, setState] = useState<State | null>(null);
  const [plan, setPlan] = useState<{ tool: string; params: Record<string, unknown> } | null>(null);
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [prev, setPrev] = useState<SimulationReport | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [exec, setExec] = useState<ExecutionReport | null>(null);
  const [rolled, setRolled] = useState<RollbackReport | null>(null);
  const [drift, setDrift] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const [predicting, setPredicting] = useState(false);
  const booted = useRef(false);

  const refreshState = useCallback(async () => {
    const s = (await fetch("/api/state").then((r) => r.json())) as State;
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    (async () => {
      const s = await refreshState();
      if (s.provisioned) {
        setPhase("idle");
        return;
      }
      setPhase("provisioning");
      try {
        await post("/api/sandbox");
        await refreshState();
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
      }
    })();
  }, [refreshState]);

  const loadConsequences = useCallback(async (runId: string) => {
    setPredicting(true);
    try {
      const c = await post<Consequences>("/api/consequences", { runId });
      // A newer simulation may have landed while the model was still thinking.
      setReport((cur) => (cur && cur.runId === runId ? { ...cur, consequences: c } : cur));
    } catch {
      // The prediction is advisory; failing to get one is not a failure state.
    } finally {
      setPredicting(false);
    }
  }, []);

  function resetRun() {
    setReport(null);
    setPrev(null);
    setGrant(null);
    setExec(null);
    setRolled(null);
    setDrift(null);
    setError(null);
  }

  async function runSimulation(body: Record<string, unknown>, keepPrev = false) {
    setError(null);
    if (!keepPrev) setPrev(null);
    setPhase("simulating");
    try {
      const r = await post<SimulationReport>("/api/simulate", body);
      setReport(r);
      setGrant(null);
      setExec(null);
      setPhase("reviewing");
      // Proven evidence is on screen now; the opinion can arrive late.
      void loadConsequences(r.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(report ? "reviewing" : "idle");
    }
  }

  async function onPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id)!;
    resetRun();
    setPlan({ tool: p.plan.tool, params: p.plan.params as Record<string, unknown> });
    setIntent(p.intent);
    await runSimulation({ presetId: id });
  }

  async function onFreeText() {
    if (!intent.trim()) return;
    resetRun();
    setPhase("planning");
    try {
      const { plan: p } = await post<{ plan: { tool: string; params: Record<string, unknown> } }>(
        "/api/plan",
        { intent }
      );
      setPlan(p);
      await runSimulation({ plan: p, intent });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  /**
   * Rows ticked off by hand in the diff.
   *
   * Unlike a remedy, this states the whole exclusion set rather than adding to
   * it, so re-including a row the operator previously removed actually works.
   */
  async function onSelectRows(excludedIds: string[]) {
    if (!plan || !report) return;
    const key = plan.tool === "customers.purge" ? "excludeCustomerIds" : "excludeOrderIds";
    const next = { tool: plan.tool, params: { ...plan.params, [key]: excludedIds } };
    setPlan(next);
    setPrev(report);
    await runSimulation({ plan: next, intent }, true);
  }

  async function onRemedy(patch: Record<string, unknown>) {
    if (!plan || !report) return;
    const next = { tool: plan.tool, params: mergePatch(plan.params, patch) };
    setPlan(next);
    setPrev(report);
    await runSimulation({ plan: next, intent }, true);
  }

  async function onApprove() {
    if (!report) return;
    setError(null);
    setPhase("approving" as Phase);
    try {
      const g = await post<Grant>("/api/approve", {
        runId: report.runId,
        planHash: report.planHash,
      });
      setGrant(g);
      setPhase("approved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("reviewing");
    }
  }

  async function onExecute() {
    if (!report || !grant) return;
    setError(null);
    setPhase("executing");
    try {
      const r = await post<ExecutionReport>("/api/execute", {
        runId: report.runId,
        token: grant.token,
      });
      setExec(r);
      setPhase("executed");
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("approved");
    }
  }

  async function onDrift() {
    if (!report) return;
    try {
      const r = await post<{ message: string }>("/api/drift", { runId: report.runId });
      setDrift(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRollback() {
    if (!report) return;
    setPhase("rollingback");
    try {
      setRolled(await post<RollbackReport>("/api/rollback", { runId: report.runId }));
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPhase("executed");
  }

  async function onResetSandbox() {
    resetRun();
    setPlan(null);
    setPhase("provisioning");
    try {
      await post("/api/sandbox", { reset: true });
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPhase("idle");
  }

  const busy = ["simulating", "planning", "executing", "provisioning", "rollingback"].includes(
    phase
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <Header state={state} onReset={onResetSandbox} busy={busy} />

      <IntentBar
        intent={intent}
        setIntent={setIntent}
        onPreset={onPreset}
        onFreeText={onFreeText}
        phase={phase}
        gemini={state?.gemini ?? false}
        busy={busy}
      />

      {error && (
        <div className="mt-4 rounded border border-block/40 bg-block-dim/40 p-3 text-sm text-block">
          {error}
        </div>
      )}

      {phase === "provisioning" && (
        <Waiting text="Provisioning your sandbox — creating real Stripe test charges…" />
      )}
      {phase === "planning" && <Waiting text="Compiling that sentence into an action plan…" />}
      {phase === "simulating" && (
        <Waiting text="Performing the write against the real database, then rolling it back…" />
      )}

      {report && !busy && (
        <div className="mt-6 space-y-4 slide-up">
          {prev && <PlanChanged prev={prev} next={report} />}
          <Verdict report={report} />
          <Evidence report={report} predicting={predicting} />
          <Invariants report={report} onRemedy={onRemedy} busy={busy} />
          <Diff report={report} onApplySelection={onSelectRows} busy={busy} />
          <Rollback report={report} />

          <ActionBar
            report={report}
            phase={phase}
            grant={grant}
            onApprove={onApprove}
            onExecute={onExecute}
            onDrift={onDrift}
            onReject={() => {
              resetRun();
              setPhase("idle");
            }}
            drift={drift}
          />
        </div>
      )}

      {phase === "executing" && <Waiting text="Executing in stages, verifying between each…" />}

      {exec && phase !== "executing" && (
        <Execution exec={exec} rolled={rolled} onRollback={onRollback} busy={busy} />
      )}

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------- header */

function Header({
  state,
  onReset,
  busy,
}: {
  state: State | null;
  onReset: () => void;
  busy: boolean;
}) {
  return (
    <header className="mb-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Preflight</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
            A simulation gate for agent writes. Nothing reaches a real system without a proven
            diff, a policy check, and a rollback receipt.
          </p>
        </div>
        <button
          onClick={onReset}
          disabled={busy}
          className="rounded border border-line bg-panel px-3 py-1.5 text-xs text-muted transition hover:border-faint hover:text-ink disabled:opacity-40"
        >
          Reset sandbox
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone={state?.stripe ? "proven" : "neutral"}>
          {state?.stripe ? "Stripe test mode · live" : "Stripe off"}
        </Badge>
        <Badge tone={state?.gemini ? "predicted" : "neutral"}>
          {state?.gemini ? "Gemini · consequence model" : "rule-based consequences"}
        </Badge>
        <Badge tone="neutral">Postgres · real transactions</Badge>
        {state?.totals && (
          <span className="font-mono text-[11px] text-faint">
            {state.totals.orders} orders · {money(state.totals.captured)} captured ·{" "}
            {money(state.totals.refunded)} refunded
          </span>
        )}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- intent bar */

function IntentBar({
  intent,
  setIntent,
  onPreset,
  onFreeText,
  phase,
  gemini,
  busy,
}: {
  intent: string;
  setIntent: (s: string) => void;
  onPreset: (id: string) => void;
  onFreeText: () => void;
  phase: Phase;
  gemini: boolean;
  busy: boolean;
}) {
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onPreset(p.id)}
            disabled={busy || phase === "boot"}
            title={p.hint}
            className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink transition hover:border-accent/50 hover:bg-accent-dim disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && onFreeText()}
          placeholder={
            gemini ? "…or describe what you want to do" : "Set GEMINI_API_KEY to type free-form intents"
          }
          disabled={!gemini || busy}
          className="min-w-0 flex-1 rounded border border-line bg-ground px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={onFreeText}
          disabled={!gemini || busy || !intent.trim()}
          className="rounded border border-accent/40 bg-accent-dim px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
        >
          Simulate
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- transitions */

function Waiting({ text }: { text: string }) {
  return (
    <div className="mt-6 rounded-lg border border-line bg-panel p-8 text-center">
      <div className="pulse-soft font-mono text-sm text-muted">{text}</div>
    </div>
  );
}

function PlanChanged({ prev, next }: { prev: SimulationReport; next: SimulationReport }) {
  const dm = next.summary.moneyCents - prev.summary.moneyCents;
  const dr = next.summary.acting - prev.summary.acting;

  return (
    <div className="rounded border border-accent/30 bg-accent-dim/40 p-3 text-xs">
      <span className="font-semibold text-accent">Plan revised.</span>{" "}
      <span className="text-muted">
        {dr === 0 ? "Same" : dr > 0 ? `${dr} more` : `${Math.abs(dr)} fewer`} order(s),{" "}
        {dm === 0 ? "no change in" : dm > 0 ? `${money(dm)} more` : `${money(Math.abs(dm))} less`}{" "}
        money. The previous approval, if any, is now void because the plan hash changed from{" "}
      </span>
      <code className="font-mono text-faint">{prev.planHash.slice(0, 8)}</code>
      <span className="text-muted"> to </span>
      <code className="font-mono text-accent">{next.planHash.slice(0, 8)}</code>
      <span className="text-muted">.</span>
    </div>
  );
}

/* --------------------------------------------------------------- action bar */

function ActionBar({
  report,
  phase,
  grant,
  onApprove,
  onExecute,
  onDrift,
  onReject,
  drift,
}: {
  report: SimulationReport;
  phase: Phase;
  grant: Grant | null;
  onApprove: () => void;
  onExecute: () => void;
  onDrift: () => void;
  onReject: () => void;
  drift: string | null;
}) {
  const blocked = report.verdict === "blocked";
  if (phase === "executed" || phase === "executing") return null;

  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      {!grant ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onApprove}
            disabled={blocked}
            className="rounded bg-proven px-4 py-2 text-sm font-semibold text-ground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            Approve —{" "}
            {report.summary.moneyCents > 0
              ? `${money(report.summary.moneyCents)} across ${report.summary.acting} orders`
              : `${report.summary.acting} ${report.tool === "customers.purge" ? "customer" : "record"}(s)`}
          </button>
          <button
            onClick={onReject}
            className="rounded border border-line px-3 py-2 text-sm text-muted transition hover:border-faint hover:text-ink"
          >
            Reject
          </button>
          <p className="text-xs text-faint">
            {blocked
              ? "Blocked plans cannot be approved. Apply a fix above to revise the plan."
              : "Approval is single-use, expires in 5 minutes, and is bound to this exact plan."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="pass">Approved</Badge>
            <span className="font-mono text-xs text-muted">
              token bound to {report.planHash.slice(0, 8)} · expires{" "}
              {new Date(grant.expiresAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onExecute}
              className="rounded bg-proven px-4 py-2 text-sm font-semibold text-ground transition hover:brightness-110"
            >
              Execute for real
            </button>
            {report.tool === "refund.bulk" && (
              <button
                onClick={onDrift}
                className="rounded border border-predicted/40 bg-predicted-dim px-3 py-2 text-xs font-medium text-predicted transition hover:bg-predicted/20"
              >
                Failure test: change Stripe behind our back
              </button>
            )}
          </div>

          <p className="text-xs leading-relaxed text-faint" hidden={report.tool !== "refund.bulk"}>
            The failure test issues a refund directly in Stripe, the way a support agent would.
            The forecast you just approved becomes stale, and nothing in this database knows it.
            Execute afterwards to watch the canary catch it.
          </p>

          {drift && (
            <div className="rounded border border-predicted/40 bg-predicted-dim/50 p-3 text-xs leading-relaxed text-ink">
              {drift}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- execution */

function Execution({
  exec,
  rolled,
  onRollback,
  busy,
}: {
  exec: ExecutionReport;
  rolled: RollbackReport | null;
  onRollback: () => void;
  busy: boolean;
}) {
  const halted = exec.status === "halted";

  return (
    <section className="mt-6 space-y-4 slide-up">
      <div
        className={`rounded-lg border p-4 ${
          halted ? "border-block/40 bg-block-dim/40" : "border-proven/40 bg-proven-dim/40"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            className={`font-mono text-sm font-bold tracking-wider ${
              halted ? "text-block" : "text-proven"
            }`}
          >
            {halted ? "HALTED BY THE CIRCUIT BREAKER" : "EXECUTED"}
          </span>
          <span className="font-mono text-xs text-muted">
            {exec.totals.entities} {exec.noun}(s) {exec.noun === "order" ? "refunded" : "purged"}
            {exec.totals.cents > 0 && ` · ${money(exec.totals.cents)}`}
            {exec.untouched > 0 && ` · ${exec.untouched} never touched`}
          </span>
        </div>
        {exec.haltReason && (
          <p className="mt-2 text-sm leading-relaxed text-ink">{exec.haltReason}</p>
        )}
      </div>

      <div className="rounded-lg border border-line bg-panel">
        <header className="border-b border-line px-4 py-2.5">
          <h3 className="text-sm font-semibold text-ink">Stages</h3>
        </header>
        <ul className="divide-y divide-line-soft">
          {exec.stages.map((s) => (
            <li key={s.stage} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-16 font-mono text-[11px] uppercase tracking-wider text-faint">
                {s.kind}
              </span>
              <Badge
                tone={s.status === "ok" ? "pass" : s.status === "halted" ? "block" : "neutral"}
              >
                {s.status === "not_reached" ? "never ran" : s.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                {s.references.join("  ")}
              </span>
              {s.refundIds.length > 0 && (
                <span className="font-mono text-[11px] text-proven">
                  {s.refundIds.length} stripe refund(s)
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {exec.divergences.length > 0 && (
        <div className="rounded-lg border border-block/40 bg-panel">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <h3 className="text-sm font-semibold text-ink">Divergence</h3>
            <Badge tone="block">Forecast was wrong</Badge>
          </header>
          <ul className="divide-y divide-line-soft">
            {exec.divergences.map((d, i) => (
              <li key={i} className="px-4 py-3">
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={d.severity === "critical" ? "block" : "warn"}>{d.kind}</Badge>
                </div>
                <p className="text-xs leading-relaxed text-ink">{d.detail}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <pre className="overflow-auto rounded border border-line bg-ground p-2 font-mono text-[10px] text-muted">
                    predicted {JSON.stringify(d.predicted, null, 1)}
                  </pre>
                  <pre className="overflow-auto rounded border border-block/30 bg-ground p-2 font-mono text-[10px] text-block">
                    actual {JSON.stringify(d.actual, null, 1)}
                  </pre>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-line bg-panel p-4">
        {!rolled ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onRollback}
              disabled={busy}
              className="rounded border border-accent/40 bg-accent-dim px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
            >
              Roll back
            </button>
            <p className="text-xs text-faint">
              Replays the compensating steps captured during simulation, newest stage first.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="pass">Rolled back</Badge>
              <span className="font-mono text-xs text-muted">
                {rolled.receiptsApplied} receipt(s) · {rolled.rowsRestored} rows restored
              </span>
            </div>
            {rolled.irreversible.length > 0 && (
              <p className="text-xs leading-relaxed text-block">
                {rolled.irreversible.length} Stripe refund(s) could not be reversed. The database
                is restored; the money is gone. That asymmetry is the reason this gate exists.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-10 border-t border-line pt-5 text-xs leading-relaxed text-faint">
      <p>
        Every simulation on this page runs the real SQL against a real Postgres database inside a
        transaction that is rolled back, and reconciles against real Stripe test-mode charges.
        Nothing here is mocked.
      </p>
    </footer>
  );
}
