"use client";

import { useEffect, useMemo, useState } from "react";
import type { SimulationReport } from "@/lib/gateway";
import type { Impact } from "@/lib/actions/types";
import type { InvariantResult, Severity } from "@/lib/policy/invariants";
import { money } from "@/lib/policy/invariants";

/* ---------------------------------------------------------------- primitives */

export function Badge({
  tone,
  children,
}: {
  tone: "proven" | "predicted" | "block" | "warn" | "pass" | "neutral";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    proven: "bg-proven-dim text-proven border-proven/30",
    predicted: "bg-predicted-dim text-predicted border-predicted/30",
    block: "bg-block-dim text-block border-block/30",
    warn: "bg-predicted-dim text-predicted border-predicted/30",
    pass: "bg-proven-dim text-proven border-proven/30",
    neutral: "bg-panel-2 text-muted border-line",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-0.5 font-mono text-lg leading-tight ${tone ?? "text-ink"}`}>{value}</div>
    </div>
  );
}

function Panel({
  title,
  badge,
  subtitle,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {badge}
      </header>
      {subtitle && <p className="px-4 pt-3 text-xs leading-relaxed text-muted">{subtitle}</p>}
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- verdict */

export function Verdict({ report }: { report: SimulationReport }) {
  const blocked = report.verdict === "blocked";

  return (
    <div
      className={`rounded-lg border p-4 ${
        blocked ? "border-block/40 bg-block-dim/40" : "border-proven/40 bg-proven-dim/40"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={`font-mono text-sm font-bold tracking-wider ${
              blocked ? "text-block" : "text-proven"
            }`}
          >
            {blocked ? "BLOCKED" : "READY TO EXECUTE"}
          </span>
          <span className="text-xs text-muted">
            {blocked
              ? "Policy refused this plan. It cannot be approved as written."
              : "Every check passed against the state the database actually reached."}
          </span>
        </div>
        <code className="font-mono text-[11px] text-faint">
          plan {report.planHash.slice(0, 12)}
        </code>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Matched" value={String(report.summary.matched)} />
        <Stat label="Acting on" value={String(report.summary.acting)} />
        {report.summary.moneyCents > 0 ? (
          <Stat
            label="Money moving"
            value={money(report.summary.moneyCents)}
            tone={blocked ? "text-block" : "text-proven"}
          />
        ) : (
          <Stat
            label="Unnamed effects"
            value={String(report.proven.unnamedEffects.reduce((n, u) => n + u.rows, 0))}
            tone={blocked ? "text-block" : "text-predicted"}
          />
        )}
        {report.proven.failure ? (
          <Stat label="Outcome" value="refused" tone="text-block" />
        ) : (
          <Stat label="Rows changed" value={String(report.proven.changeCount)} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ evidence */

export function Evidence({
  report,
  predicting = false,
}: {
  report: SimulationReport;
  predicting?: boolean;
}) {
  const c = report.consequences;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="What will happen"
        badge={<Badge tone="proven">Proven</Badge>}
        subtitle="Measured, not estimated. The write was performed against the real database inside a transaction that was then rolled back."
      >
        <dl className="space-y-2">
          {Object.entries(report.proven.tableCounts).map(([table, rows]) => (
            <div key={table} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="font-mono text-muted">preflight.{table}</dt>
              <dd className="font-mono text-ink">{rows} rows</dd>
            </div>
          ))}
          {report.proven.changeCount === 0 &&
            (report.proven.failure ? (
              <p className="text-sm leading-relaxed text-muted">
                Nothing changed, because the database{" "}
                <span className="text-block">refused the write outright</span>. The constraint
                that stopped it is in the policy section below — this is a fact about the data,
                discovered by attempting the write rather than by asking.
              </p>
            ) : (
              <p className="text-sm text-muted">This plan changes nothing.</p>
            ))}
        </dl>

        {report.proven.unnamedEffects.length > 0 && (
          <div className="mt-4 rounded border border-predicted/25 bg-predicted-dim/30 p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-predicted">
              Effects the request never mentioned
            </div>
            <ul className="space-y-1">
              {report.proven.unnamedEffects.map((u) => (
                <li key={u.table} className="font-mono text-xs text-ink">
                  {u.rows} rows written to preflight.{u.table}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.stripe.enabled && report.stripe.charges > 0 && (
          <p className="mt-4 border-t border-line-soft pt-3 text-xs text-muted">
            Reconciled {report.stripe.charges} charge(s) against Stripe.{" "}
            {report.stripe.drifted > 0 ? (
              <span className="text-block">
                {report.stripe.drifted} disagree with our local record.
              </span>
            ) : (
              <span className="text-proven">All agree.</span>
            )}
          </p>
        )}
      </Panel>

      <Panel
        title="What might follow"
        badge={<Badge tone="predicted">Predicted</Badge>}
        subtitle="A model's reasoning about effects outside the database. Treat as a hypothesis. It never blocks anything on its own."
      >
        {!c && predicting ? (
          <div className="space-y-3">
            <p className="pulse-soft text-sm text-muted">
              Asking the model what happens outside the database…
            </p>
            <div className="space-y-2">
              {[100, 82, 64].map((w) => (
                <div
                  key={w}
                  className="pulse-soft h-2 rounded bg-line"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
            <p className="text-xs leading-relaxed text-faint">
              Everything on the left is already final. Nothing here can change it, block it, or
              hold up an approval.
            </p>
          </div>
        ) : !c ? (
          <p className="text-sm text-muted">No prediction available.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-ink">{c.summary}</p>

            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-faint">Confidence</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-predicted"
                  style={{ width: `${Math.round(c.confidence * 100)}%` }}
                />
              </div>
              <span className="font-mono text-xs text-predicted">
                {Math.round(c.confidence * 100)}%
              </span>
              <span className="ml-auto font-mono text-[10px] text-faint">
                {c.source === "gemini" ? "gemini" : "rule-based"}
              </span>
            </div>

            {[
              ["Who is affected", c.impacted],
              ["Side effects", c.sideEffects],
              ["Watch for", c.watchFor],
            ].map(([label, items]) =>
              (items as string[]).length ? (
                <div key={label as string}>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
                    {label as string}
                  </div>
                  <ul className="space-y-1">
                    {(items as string[]).map((s, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-muted">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-predicted" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- invariants */

export function Invariants({
  report,
  onRemedy,
  busy,
}: {
  report: SimulationReport;
  onRemedy: (patch: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const order: Record<Severity, number> = { block: 0, warn: 1, pass: 2 };
  const sorted = [...report.invariants].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <Panel title="Policy" badge={<Badge tone="proven">Proven</Badge>}>
      <ul className="space-y-2">
        {sorted.map((i) => (
          <InvariantRow key={i.id} invariant={i} onRemedy={onRemedy} busy={busy} />
        ))}
      </ul>
    </Panel>
  );
}

function InvariantRow({
  invariant: i,
  onRemedy,
  busy,
}: {
  invariant: InvariantResult;
  onRemedy: (patch: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tone =
    i.severity === "block" ? "border-block/30" : i.severity === "warn" ? "border-predicted/25" : "border-line";

  return (
    <li className={`rounded border ${tone} bg-panel-2/60 p-3`}>
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone={i.severity}>{i.severity === "pass" ? "ok" : i.severity}</Badge>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{i.label}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{i.detail}</p>

          {i.evidence && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="mt-1.5 font-mono text-[11px] text-accent hover:underline"
            >
              {open ? "hide evidence" : "show evidence"}
            </button>
          )}
          {open && i.evidence && (
            <pre className="mt-2 max-h-52 overflow-auto rounded border border-line bg-ground p-2 font-mono text-[11px] leading-relaxed text-muted">
              {JSON.stringify(i.evidence, null, 2)}
            </pre>
          )}
        </div>

        {i.remedy && (
          <button
            disabled={busy}
            onClick={() => onRemedy(i.remedy!.patch)}
            className="shrink-0 rounded border border-accent/40 bg-accent-dim px-2.5 py-1 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
          >
            {i.remedy.label}
          </button>
        )}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------------- diff */

const DIFF_HEADERS: Record<string, [string, string, string, string, string]> = {
  "refund.bulk": ["Order", "Customer", "Refunded", "After", "Change"],
  "customers.purge": ["Customer", "Contact", "Status", "After", "Effect"],
  "notify.broadcast": ["Recipient", "Contact", "State", "After", "Effect"],
};

/** Deselected by hand, as opposed to skipped because there is nothing to do. */
const DESELECTED = "deselected by operator";

export function Diff({
  report,
  onApplySelection,
  busy = false,
}: {
  report: SimulationReport;
  /** Re-simulate with exactly this set of rows excluded. */
  onApplySelection?: (excludedIds: string[]) => void;
  busy?: boolean;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const [h1, h2, h3, h4, h5] = DIFF_HEADERS[report.tool] ?? DIFF_HEADERS["refund.bulk"];

  // A row can be toggled unless the database has nothing to do with it anyway.
  const toggleable = (i: Impact) => !i.skipped || i.skipped === DESELECTED;
  const excludedInPlan = useMemo(
    () => new Set(report.impacts.filter((i) => i.skipped === DESELECTED).map((i) => i.id)),
    [report]
  );

  const [excluded, setExcluded] = useState<Set<string>>(excludedInPlan);

  // A new simulation replaces the selection; the plan is the source of truth.
  useEffect(() => setExcluded(excludedInPlan), [excludedInPlan]);

  const dirty =
    excluded.size !== excludedInPlan.size || [...excluded].some((id) => !excludedInPlan.has(id));

  const rows = showSkipped
    ? report.impacts
    : report.impacts.filter((i) => !i.skipped || excluded.has(i.id));
  const hiddenCount = report.impacts.length - rows.length;

  function toggle(id: string) {
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Panel
      title="Row-level diff"
      badge={<Badge tone="proven">Proven</Badge>}
      subtitle="Every row this plan touches, before and after, taken from the rolled-back transaction. Untick anything you do not want and re-simulate."
    >
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-faint">
              <th className="w-8 px-4 py-2" />
              <th className="px-2 py-2 text-left font-medium">{h1}</th>
              <th className="px-2 py-2 text-left font-medium">{h2}</th>
              <th className="px-2 py-2 text-right font-medium">{h3}</th>
              <th className="px-2 py-2 text-center font-medium" />
              <th className="px-2 py-2 text-right font-medium">{h4}</th>
              <th className="px-4 py-2 text-right font-medium">{h5}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const off = excluded.has(i.id);
              const can = toggleable(i);
              return (
                <tr
                  key={i.id}
                  onClick={() => can && !busy && toggle(i.id)}
                  className={`border-b border-line-soft last:border-0 ${
                    can && !busy ? "cursor-pointer hover:bg-panel-2/70" : ""
                  } ${off || (i.skipped && i.skipped !== DESELECTED) ? "opacity-40" : ""}`}
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={!off}
                      disabled={!can || busy}
                      onChange={() => toggle(i.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Include ${i.label}`}
                      className="h-3.5 w-3.5 accent-proven"
                    />
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">{i.label}</td>
                  <td className="max-w-[180px] truncate px-2 py-2 text-xs text-muted">
                    {String(i.who).split(" <")[0]}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-block">{i.from}</td>
                  <td className="px-2 py-2 text-center font-mono text-xs text-faint">→</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-proven">
                    {off ? "—" : i.to}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {off ? (
                      <span className="text-[11px] text-faint">excluded</span>
                    ) : i.skipped ? (
                      <span className="text-[11px] text-faint">{i.skipped}</span>
                    ) : (
                      <span className="font-mono text-xs text-ink">{i.delta}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowSkipped((v) => !v)}
            className="font-mono text-[11px] text-accent hover:underline"
          >
            {showSkipped ? "hide" : "show"} {hiddenCount} skipped row(s)
          </button>
        )}

        {dirty && onApplySelection && (
          <div className="ml-auto flex items-center gap-2 slide-up">
            <button
              onClick={() => setExcluded(excludedInPlan)}
              disabled={busy}
              className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:border-faint hover:text-ink disabled:opacity-40"
            >
              Reset
            </button>
            <button
              onClick={() => onApplySelection([...excluded])}
              disabled={busy}
              className="rounded border border-accent/40 bg-accent-dim px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
            >
              Re-simulate with {excluded.size} excluded
            </button>
          </div>
        )}
      </div>

      {dirty && (
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          Nothing changes until you re-simulate. Doing so produces a new plan hash, which voids
          any approval already granted for the current one.
        </p>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ rollback */

export function Rollback({ report }: { report: SimulationReport }) {
  return (
    <Panel
      title="Rollback path"
      badge={<Badge tone="proven">Proven</Badge>}
      subtitle="Derived from the pre-images captured while the write ran, so undo is recorded data rather than a guess made later."
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <span className="font-mono text-ink">{report.rollback.steps} compensating steps</span>
        {Object.entries(report.rollback.byTable).map(([t, ops]) => (
          <span key={t} className="font-mono text-xs text-muted">
            {t}: {ops.restore ? `${ops.restore} restore ` : ""}
            {ops.delete ? `${ops.delete} delete ` : ""}
            {ops.reinsert ? `${ops.reinsert} reinsert` : ""}
          </span>
        ))}
      </div>

      {report.rollback.irreversible.length > 0 && (
        <div className="mt-4 rounded border border-block/30 bg-block-dim/40 p-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="block">Irreversible</Badge>
            <span className="text-xs font-medium text-ink">
              {report.rollback.irreversible.length} effect(s) cannot be undone
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            A completed Stripe refund is final. Rolling back restores this database, but the money
            has left. This is the part that makes the gate worth having.
          </p>
        </div>
      )}
    </Panel>
  );
}
