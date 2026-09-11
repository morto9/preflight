import { db, asJson, jsonb, type PgFailure } from "@/lib/db";
import {
  dryRun,
  executeFirstStage,
  executeStage,
  executeRollback,
  type AuditRow,
  type Tx,
} from "@/lib/adapters/postgres";
import { ActionPlan, planHash, type ToolName } from "@/lib/plan/schema";
import type { ActionCtx, ExternalEffect, Impact } from "@/lib/actions/types";
import {
  applyCompensation,
  buildCompensation,
  describeCompensation,
  type CompensationStep,
} from "@/lib/gateway/compensate";
import {
  refundInvariants,
  purgeInvariants,
  worstSeverity,
  money,
  type InvariantResult,
} from "@/lib/policy/invariants";
import {
  recordDivergences,
  tripBreaker,
  verifyAfterStage,
  verifyBeforeStage,
  worstDivergence,
  type Divergence,
  type Forecast,
} from "@/lib/gateway/verifier";
import * as refundBulk from "@/lib/actions/refund-bulk";
import * as customerPurge from "@/lib/actions/customer-purge";
import { refundCharge, stripeEnabled } from "@/lib/adapters/stripe";
import { hashToken } from "@/lib/gateway/approval";

/**
 * The gateway.
 *
 * Every write to a business table passes through here. The database enforces
 * that independently -- see db/migrations/002_gate.sql -- so this module is the
 * only place that knows how to open the gate, and forgetting to use it is a
 * failure that Postgres raises rather than one that ships.
 */

const CANARY_SIZE = 1;
const BATCH_SIZE = 5;

export type Verdict = "ready" | "blocked";

export type SimulationReport = {
  runId: string;
  tool: ToolName;
  planHash: string;
  intent?: string;
  createdAt: string;

  summary: {
    matched: number;
    acting: number;
    skipped: number;
    moneyCents: number;
  };

  /** Row-level before/after, the diff the operator reads. */
  impacts: Impact[];

  /**
   * Facts, not forecasts: these came from Postgres actually performing the
   * write inside a transaction that was then rolled back.
   */
  proven: {
    changeCount: number;
    tableCounts: Record<string, number>;
    /** Rows changed by cascade that the plan never named. */
    unnamedEffects: { table: string; rows: number }[];
    /** The actual audit rows, so "42 rows changed" can be inspected. */
    sample: AuditSample[];
    failure?: PgFailure;
  };

  invariants: InvariantResult[];
  verdict: Verdict;

  external: ExternalEffect[];

  rollback: {
    steps: number;
    byTable: Record<string, { restore: number; delete: number; reinsert: number }>;
    irreversible: ExternalEffect[];
  };

  stripe: { enabled: boolean; charges: number; drifted: number };

  /**
   * Exactly what this plan committed to, per order. Execution verifies reality
   * against THIS rather than against freshly-read state.
   */
  forecast: Forecast;

  /** Filled in by the consequence model. Explicitly a prediction. */
  consequences?: Consequences;
};

/** One row the dry run touched, reduced to what a human would want to read. */
export type AuditSample = {
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  pk: string | null;
  /** For an UPDATE, only the fields that actually differ. */
  changed: { field: string; from: unknown; to: unknown }[];
  /** For an INSERT or DELETE, a few identifying fields. */
  summary: Record<string, unknown>;
};

export type Consequences = {
  source: "gemini" | "rules";
  confidence: number;
  impacted: string[];
  sideEffects: string[];
  watchFor: string[];
  summary: string;
  /** Which model answered, when one did. */
  model?: string;
  /** Set when this is the rules fallback, saying plainly why. */
  degraded?: string;
  /** True when served from cache rather than a fresh model call. */
  cached?: boolean;
};

// ---------------------------------------------------------------------------
// SIMULATE
// ---------------------------------------------------------------------------

export async function simulate(args: {
  tenantId: string;
  plan: ActionPlan;
  intent?: string;
}): Promise<SimulationReport> {
  const sql = db();
  const plan = ActionPlan.parse(args.plan);
  const hash = planHash(plan);

  const [runRow] = await sql`
    insert into preflight.runs (tenant_id, intent, plan, plan_hash, status)
    values (${args.tenantId}, ${args.intent ?? null}, ${jsonb(plan)}, ${hash}, 'simulated')
    returning id, created_at`;

  const runId = String(runRow.id);
  const ctx: ActionCtx = { tenantId: args.tenantId, runId, mode: "simulate", stage: 0 };

  const outcome =
    plan.tool === "refund.bulk"
      ? await simulateRefundBulk(sql, ctx, plan.params)
      : plan.tool === "customers.purge"
        ? await simulatePurge(sql, ctx, plan.params)
        : null;

  if (!outcome) {
    throw new Error(`preflight: tool ${plan.tool} is not wired into the gateway yet`);
  }

  const { dry } = outcome;
  const invariants = [...outcome.invariants];

  // A refusal by the database outranks every policy opinion, so it goes first.
  if (dry.failure) {
    invariants.unshift({
      id: "database_refused",
      label: "The database refused this write",
      severity: "block",
      detail: `${dry.failure.message}${dry.failure.detail ? ` -- ${dry.failure.detail}` : ""}`,
      evidence: { code: dry.failure.code, constraint: dry.failure.constraint },
    });
  }

  // Derive the rollback path from the pre-images just captured.
  const compensation = buildCompensation(dry.changes);

  const report: SimulationReport = {
    runId,
    tool: plan.tool,
    planHash: hash,
    intent: args.intent,
    createdAt: new Date(runRow.created_at as string).toISOString(),
    summary: outcome.summary,
    impacts: outcome.impacts,
    proven: {
      changeCount: dry.changes.length,
      tableCounts: countByTable(dry.changes),
      unnamedEffects: unnamedEffects(dry.changes, plan.tool),
      sample: auditSample(dry.changes),
      failure: dry.failure,
    },
    invariants,
    verdict: worstSeverity(invariants) === "block" ? "blocked" : "ready",
    external: outcome.external,
    rollback: {
      ...describeCompensation(compensation),
      steps: compensation.length,
      irreversible: outcome.external.filter((e) => !e.reversible),
    },
    stripe: outcome.stripe,
    forecast: outcome.forecast,
  };

  await sql`
    update preflight.runs
       set simulation = ${jsonb(report)}, updated_at = now()
     where id = ${runId}::uuid`;

  return report;
}

function countByTable(changes: AuditRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) out[c.table_name] = (out[c.table_name] ?? 0) + 1;
  return out;
}

/**
 * Reduce raw audit rows to something readable. An UPDATE is shown as the fields
 * that actually differ rather than the whole row, which is usually two or three
 * columns out of a dozen.
 */
const IDENTIFYING = ["reference", "email", "name", "kind", "amount_cents", "memo", "status", "number"];

function auditSample(changes: AuditRow[], limit = 24): AuditSample[] {
  return changes.slice(0, limit).map((c) => {
    const row = (c.after_row ?? c.before_row ?? {}) as Record<string, unknown>;

    const changed =
      c.op === "UPDATE" && c.before_row && c.after_row
        ? Object.keys(c.after_row)
            .filter(
              (k) =>
                JSON.stringify((c.before_row as Record<string, unknown>)[k]) !==
                JSON.stringify((c.after_row as Record<string, unknown>)[k])
            )
            .map((field) => ({
              field,
              from: (c.before_row as Record<string, unknown>)[field],
              to: (c.after_row as Record<string, unknown>)[field],
            }))
        : [];

    const summary: Record<string, unknown> = {};
    for (const k of IDENTIFYING) if (row[k] !== undefined && row[k] !== null) summary[k] = row[k];

    return { table: c.table_name, op: c.op, pk: c.row_pk, changed, summary };
  });
}

/** Tables a given tool's request can fairly be said to be about. */
const NAMED_TABLES: Record<ToolName, string[]> = {
  "refund.bulk": ["orders", "refunds"],
  "customers.purge": ["customers"],
  "notify.broadcast": ["notifications"],
};

/**
 * Tables the plan never mentions but nonetheless changed. This is the part of
 * a blast radius that people are usually surprised by.
 */
function unnamedEffects(
  changes: AuditRow[],
  tool: ToolName
): { table: string; rows: number }[] {
  const named = new Set(NAMED_TABLES[tool]);
  return Object.entries(countByTable(changes))
    .filter(([t]) => !named.has(t))
    .map(([table, rows]) => ({ table, rows }));
}

// ---------------------------------------------------------------------------
// Per-tool simulation
// ---------------------------------------------------------------------------

type RefundParams = Extract<ActionPlan, { tool: "refund.bulk" }>["params"];
type PurgeParams = Extract<ActionPlan, { tool: "customers.purge" }>["params"];

/** What every tool must produce so the report can be assembled uniformly. */
type ToolOutcome = {
  dry: { changes: AuditRow[]; failure?: PgFailure };
  impacts: Impact[];
  invariants: InvariantResult[];
  external: ExternalEffect[];
  summary: SimulationReport["summary"];
  forecast: Forecast;
  stripe: SimulationReport["stripe"];
};

async function simulateRefundBulk(
  sql: ReturnType<typeof db>,
  ctx: ActionCtx,
  params: RefundParams
): Promise<ToolOutcome> {
  // Resolve against real rows, then ask Stripe what is actually true.
  let targets = await refundBulk.resolveTargets(sql, ctx, params);
  targets = await refundBulk.reconcileWithStripe(targets);
  targets = refundBulk.priceTargets(targets, params);

  // Perform the write for real, inside a transaction that rolls back.
  const dry = await dryRun((tx) => refundBulk.applyDbEffects(tx, ctx, targets, params));

  const spent = await refundBulk.spentToday(sql, ctx.tenantId);
  const acting = targets.filter((t) => t.refundCents > 0);

  return {
    dry,
    impacts: refundBulk.buildImpacts(targets),
    invariants: refundInvariants({
      targets: targets.map((t) => ({
        orderId: t.orderId,
        reference: t.reference,
        refundCents: t.refundCents,
        amountCents: t.amountCents,
        alreadyRefundedCents: t.alreadyRefundedCents,
        chargeId: t.chargeId,
        driftCents: t.driftCents,
        customerName: t.customerName,
        excluded: t.excluded,
      })),
      dailyCapCents: params.dailyCapCents,
      spentTodayCents: spent,
    }),
    external: refundBulk.externalEffects(targets),
    summary: {
      matched: targets.length,
      acting: acting.length,
      skipped: targets.length - acting.length,
      moneyCents: acting.reduce((s, t) => s + t.refundCents, 0),
    },
    forecast: Object.fromEntries(
      targets.map((t) => [
        t.orderId,
        { alreadyRefundedCents: t.alreadyRefundedCents, refundCents: t.refundCents },
      ])
    ),
    stripe: {
      enabled: stripeEnabled(),
      charges: targets.filter((t) => t.chargeId).length,
      drifted: targets.filter((t) => t.driftCents !== 0).length,
    },
  };
}

async function simulatePurge(
  sql: ReturnType<typeof db>,
  ctx: ActionCtx,
  params: PurgeParams
): Promise<ToolOutcome> {
  const targets = await customerPurge.resolveTargets(sql, ctx, params);

  // A hard delete against a customer with retained invoices raises a real
  // foreign-key violation here, which the dry run reports rather than suffers.
  const dry = await dryRun((tx) => customerPurge.applyDbEffects(tx, ctx, targets, params));
  const acting = targets.filter((t) => !t.excluded);

  return {
    dry,
    impacts: customerPurge.buildImpacts(targets, params),
    invariants: purgeInvariants({
      strategy: params.strategy,
      customerCount: acting.length,
      // Counted by real queries at resolve time, so the blast radius is still
      // reportable even when the delete itself was refused.
      cascadeCounts: customerPurge.cascadeCounts(targets),
      blockedByInvoice: customerPurge.blockedByInvoice(targets),
    }),
    external: [],
    summary: {
      matched: targets.length,
      acting: acting.length,
      skipped: targets.length - acting.length,
      moneyCents: 0,
    },
    forecast: {},
    stripe: { enabled: stripeEnabled(), charges: 0, drifted: 0 },
  };
}

// ---------------------------------------------------------------------------
// EXECUTE
// ---------------------------------------------------------------------------

export type StageReport = {
  stage: number;
  kind: "canary" | "batch";
  references: string[];
  status: "ok" | "halted" | "not_reached";
  changed: Record<string, number>;
  divergences: Divergence[];
  refundIds: string[];
  receiptId?: string;
};

/**
 * Progress emitted while a run executes.
 *
 * Execution is staged and each stage is verified, but that whole sequence used
 * to happen behind one blocking request -- so the most interesting thing this
 * system does was invisible until it was over. These let the client watch it.
 */
export type ExecEvent =
  | { type: "plan"; noun: string; stages: { stage: number; kind: "canary" | "batch"; references: string[] }[] }
  | { type: "stage:start"; stage: number }
  | { type: "stage:verify"; stage: number; phase: "before" | "after"; ok: boolean; divergences: Divergence[] }
  | { type: "stage:external"; stage: number; system: string; count: number }
  | { type: "stage:done"; stage: number; status: "ok" | "halted"; changed: Record<string, number>; externalIds: string[] }
  | { type: "halted"; stage: number; reason: string };

export type ExecutionReport = {
  runId: string;
  status: "completed" | "halted";
  haltReason?: string;
  stages: StageReport[];
  totals: { entities: number; cents: number };
  /** What the entities are, so the UI can say "3 customers" not "3 orders". */
  noun: string;
  divergences: Divergence[];
  untouched: number;
};

export async function execute(args: {
  runId: string;
  token: string;
  /** Called as each stage progresses. Fire-and-forget; never awaited. */
  onEvent?: (event: ExecEvent) => void;
}): Promise<ExecutionReport> {
  const emit = (e: ExecEvent) => args.onEvent?.(e);
  const sql = db();

  const [runRow] = await sql`
    select id, tenant_id, plan, plan_hash, simulation, status
      from preflight.runs where id = ${args.runId}::uuid`;
  if (!runRow) throw new Error("preflight: unknown run");

  const plan = ActionPlan.parse(asJson(runRow.plan));
  const storedHash = String(runRow.plan_hash);

  // The plan is re-hashed rather than trusted, so a tampered row is caught here
  // and again by the database when the gate is opened.
  if (planHash(plan) !== storedHash) {
    throw new Error("preflight: stored plan does not match its hash");
  }
  // A halted or finished run is terminal. Re-running it would be a second bite
  // at an approval the operator granted once.
  const runStatus = String(runRow.status);
  if (runStatus !== "simulated") {
    throw new Error(
      `preflight: run is "${runStatus}"; only a simulated, approved run can be executed`
    );
  }

  if (plan.tool === "customers.purge") {
    return executePurge({
      runId: args.runId,
      token: args.token,
      tenantId: String(runRow.tenant_id),
      storedHash,
      params: plan.params,
      sim: runRow.simulation ? asJson<SimulationReport>(runRow.simulation) : null,
      onEvent: args.onEvent,
    });
  }

  if (plan.tool !== "refund.bulk") {
    throw new Error(`preflight: tool ${plan.tool} is not wired into the gateway yet`);
  }

  const tenantId = String(runRow.tenant_id);
  const sim = runRow.simulation ? asJson<SimulationReport>(runRow.simulation) : null;
  const tokenHash = hashToken(args.token);

  const ctx: ActionCtx = { tenantId, runId: args.runId, mode: "execute", stage: 0 };

  // Re-resolve against current state rather than replaying the forecast.
  let targets = await refundBulk.resolveTargets(sql, ctx, plan.params);
  targets = await refundBulk.reconcileWithStripe(targets);
  targets = refundBulk.priceTargets(targets, plan.params);

  const allDivergences: Divergence[] = [];

  // Did the world move under us between simulation and now?
  if (sim) {
    const before = new Set(sim.impacts.filter((i) => !i.skipped).map((i) => i.id));
    const now = new Set(targets.filter((t) => t.refundCents > 0).map((t) => t.orderId));
    const appeared = [...now].filter((id) => !before.has(id));
    const vanished = [...before].filter((id) => !now.has(id));

    if (appeared.length || vanished.length) {
      allDivergences.push({
        kind: "row_count",
        severity: "critical",
        detail:
          `The set of orders this plan applies to changed after it was approved: ` +
          `${appeared.length} appeared, ${vanished.length} no longer qualify.`,
        predicted: { orders: before.size },
        actual: { orders: now.size, appeared: appeared.length, vanished: vanished.length },
      });
    }
  }

  const acting = targets.filter((t) => t.refundCents > 0);
  const stages = chunk(acting, CANARY_SIZE, BATCH_SIZE);
  const stageReports: StageReport[] = [];

  const forecast: Forecast = sim?.forecast ?? {};
  const totalActing = Math.max(1, sim?.summary.acting ?? acting.length);

  // applyDbEffects writes a fixed number of rows per acting order, so the
  // simulation's totals scale exactly to a stage of n orders.
  const expectedFor = (n: number): Record<string, number> =>
    Object.fromEntries(
      Object.entries(sim?.proven.tableCounts ?? {}).map(([t, c]) => [
        t,
        Math.round((c * n) / totalActing),
      ])
    );

  if (allDivergences.length > 0) {
    await tripBreaker(args.runId, 0, allDivergences, "target set changed after approval");
    return {
      runId: args.runId,
      status: "halted",
      haltReason: "The set of affected orders changed after approval.",
      stages: stages.map((s, i) => ({
        stage: i + 1,
        kind: i === 0 ? "canary" : "batch",
        references: s.map((t) => t.reference),
        status: "not_reached",
        changed: {},
        divergences: [],
        refundIds: [],
      })),
      totals: { entities: 0, cents: 0 },
      noun: "order",
      divergences: allDivergences,
      untouched: acting.length,
    };
  }

  emit({
    type: "plan",
    noun: "order",
    stages: stages.map((s, i) => ({
      stage: i + 1,
      kind: i === 0 ? "canary" : "batch",
      references: s.map((t) => t.reference),
    })),
  });

  let approvalId: string | null = null;
  let totalOrders = 0;
  let totalCents = 0;
  let halted = false;
  let haltReason: string | undefined;

  for (let i = 0; i < stages.length; i++) {
    const stageTargets = stages[i];
    const stageNo = i + 1;
    const kind: "canary" | "batch" = i === 0 ? "canary" : "batch";

    if (halted) {
      stageReports.push({
        stage: stageNo,
        kind,
        references: stageTargets.map((t) => t.reference),
        status: "not_reached",
        changed: {},
        divergences: [],
        refundIds: [],
      });
      continue;
    }

    emit({ type: "stage:start", stage: stageNo });

    // --- (a) Is the forecast still true? Check BEFORE anything irreversible.
    const pre = await verifyBeforeStage(stageTargets, forecast);
    emit({
      type: "stage:verify",
      stage: stageNo,
      phase: "before",
      ok: worstDivergence(pre) !== "critical",
      divergences: pre,
    });
    if (worstDivergence(pre) === "critical") {
      allDivergences.push(...pre);
      await tripBreaker(args.runId, stageNo, pre, "source of truth diverged from the forecast");
      halted = true;
      haltReason =
        "Stripe no longer matches the state this plan was approved against. Nothing was refunded in this stage.";
      stageReports.push({
        stage: stageNo,
        kind,
        references: stageTargets.map((t) => t.reference),
        status: "halted",
        changed: {},
        divergences: pre,
        refundIds: [],
      });
      emit({ type: "stage:done", stage: stageNo, status: "halted", changed: {}, externalIds: [] });
      emit({ type: "halted", stage: stageNo, reason: haltReason });
      continue;
    }

    // --- (b) Real money movement, idempotent per (run, order).
    const refundIds = new Map<string, string>();
    const stageDivergences: Divergence[] = [...pre];

    if (stripeEnabled()) {
      for (const t of stageTargets) {
        if (!t.chargeId) continue;
        const out = await refundCharge({
          chargeId: t.chargeId,
          amountCents: t.refundCents,
          reason: plan.params.reason,
          idempotencyKey: refundBulk.idempotencyKey(args.runId, t.orderId),
        });
        if (out.ok) {
          refundIds.set(t.orderId, out.refundId);
        } else {
          stageDivergences.push({
            kind: "external_failure",
            severity: "critical",
            detail: `${t.reference}: Stripe refused the refund -- ${out.error}`,
            predicted: { reference: t.reference, refund: money(t.refundCents) },
            actual: { error: out.error, code: out.code },
          });
        }
      }
    }

    emit({ type: "stage:external", stage: stageNo, system: "stripe", count: refundIds.size });

    // --- (c) Record it. Same DB code path the simulation used.
    const stageCtx: ActionCtx = { ...ctx, stage: stageNo };

    type StageWrite = { orders: number; cents: number };
    type StageOutcome = { value: StageWrite; changes: AuditRow[]; approvalId?: string };

    // The first stage burns the single-use approval; later stages present the
    // consumed approval, which Postgres only honours while the run is still
    // allowed to continue.
    const runStage = (fn: (tx: Tx) => Promise<StageWrite>): Promise<StageOutcome> =>
      approvalId === null
        ? executeFirstStage(args.runId, tokenHash, storedHash, fn)
        : executeStage(args.runId, approvalId, fn);

    const result = await runStage((tx) =>
      refundBulk.applyDbEffects(tx, stageCtx, stageTargets, plan.params, refundIds)
    );

    if (result.approvalId) approvalId = result.approvalId;
    totalOrders += result.value.orders;
    totalCents += result.value.cents;

    // --- (d) Receipt: the rollback path, derived from real pre-images.
    const compensation = buildCompensation(result.changes);
    const receiptId = await writeReceipt(
      args.runId,
      stageNo,
      result.changes,
      compensation,
      refundBulk
        .externalEffects(stageTargets)
        .map((e) => ({ ...e, externalId: refundIds.get(e.target) }))
    );

    // --- (e) Did reality match the forecast?
    const post = await verifyAfterStage({
      targets: stageTargets,
      expectedCounts: expectedFor(stageTargets.length),
      actualChanges: result.changes,
      refundIds,
    });
    stageDivergences.push(...post);
    emit({
      type: "stage:verify",
      stage: stageNo,
      phase: "after",
      ok: worstDivergence(post) !== "critical",
      divergences: post,
    });

    const verdict = worstDivergence(stageDivergences);
    if (verdict === "critical") {
      allDivergences.push(...stageDivergences);
      await tripBreaker(args.runId, stageNo, stageDivergences, "post-execution verification failed");
      halted = true;
      haltReason = "Reality did not match the forecast after this stage. Remaining stages were refused.";
    } else {
      await recordDivergences(args.runId, stageNo, stageDivergences);
    }

    stageReports.push({
      stage: stageNo,
      kind,
      references: stageTargets.map((t) => t.reference),
      status: halted ? "halted" : "ok",
      changed: countByTable(result.changes),
      divergences: stageDivergences,
      refundIds: [...refundIds.values()],
      receiptId,
    });

    emit({
      type: "stage:done",
      stage: stageNo,
      status: halted ? "halted" : "ok",
      changed: countByTable(result.changes),
      externalIds: [...refundIds.values()],
    });
    if (halted) emit({ type: "halted", stage: stageNo, reason: haltReason! });
  }

  if (!halted) {
    await sql`update preflight.runs set status = 'completed', updated_at = now() where id = ${args.runId}::uuid`;
  }

  // "Untouched" means nothing was attempted, so a halted stage that already
  // wrote rows does not count towards it.
  const untouched = stageReports
    .filter((s) => s.status === "not_reached")
    .reduce((n, s) => n + s.references.length, 0);

  return {
    runId: args.runId,
    status: halted ? "halted" : "completed",
    haltReason,
    stages: stageReports,
    totals: { entities: totalOrders, cents: totalCents },
    noun: "order",
    divergences: allDivergences,
    untouched,
  };
}

function chunk<T>(items: T[], canary: number, batch: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [items.slice(0, canary)];
  for (let i = canary; i < items.length; i += batch) out.push(items.slice(i, i + batch));
  return out;
}

async function writeReceipt(
  runId: string,
  stage: number,
  changes: AuditRow[],
  compensation: CompensationStep[],
  external: ExternalEffect[]
): Promise<string> {
  const sql = db();
  const [row] = await sql`
    insert into preflight.receipts (run_id, stage, pre_images, compensating, external_effects)
    values (
      ${runId}::uuid, ${stage},
      ${jsonb(changes)},
      ${jsonb(compensation)},
      ${jsonb(external)}
    )
    returning id`;
  return String(row.id);
}

/**
 * Purging customers.
 *
 * No external system is involved, so there is nothing to check before a stage
 * acts: the entire risk lives inside the database, and the dry run already
 * proved what happens there. Verification is therefore post-stage only,
 * comparing rows that actually changed against the dependent counts measured
 * at resolve time.
 */
async function executePurge(args: {
  runId: string;
  token: string;
  tenantId: string;
  storedHash: string;
  params: PurgeParams;
  sim: SimulationReport | null;
  onEvent?: (event: ExecEvent) => void;
}): Promise<ExecutionReport> {
  const emit = (e: ExecEvent) => args.onEvent?.(e);
  const sql = db();
  const ctx: ActionCtx = {
    tenantId: args.tenantId,
    runId: args.runId,
    mode: "execute",
    stage: 0,
  };
  const tokenHash = hashToken(args.token);

  const targets = await customerPurge.resolveTargets(sql, ctx, args.params);
  const acting = targets.filter((t) => !t.excluded);
  const stages = chunk(acting, CANARY_SIZE, BATCH_SIZE);
  const allDivergences: Divergence[] = [];

  const asNotReached = (): StageReport[] =>
    stages.map((s, i) => ({
      stage: i + 1,
      kind: i === 0 ? "canary" : "batch",
      references: s.map((t) => t.name),
      status: "not_reached",
      changed: {},
      divergences: [],
      refundIds: [],
    }));

  // Did the set of customers this plan applies to move under us?
  if (args.sim) {
    const before = new Set(args.sim.impacts.filter((i) => !i.skipped).map((i) => i.id));
    const now = new Set(acting.map((t) => t.customerId));
    const appeared = [...now].filter((id) => !before.has(id));
    const vanished = [...before].filter((id) => !now.has(id));

    if (appeared.length || vanished.length) {
      allDivergences.push({
        kind: "row_count",
        severity: "critical",
        detail:
          `The set of customers this plan applies to changed after it was approved: ` +
          `${appeared.length} appeared, ${vanished.length} no longer qualify.`,
        predicted: { customers: before.size },
        actual: { customers: now.size, appeared: appeared.length, vanished: vanished.length },
      });

      await tripBreaker(args.runId, 0, allDivergences, "target set changed after approval");
      return {
        runId: args.runId,
        status: "halted",
        haltReason: "The set of affected customers changed after approval.",
        stages: asNotReached(),
        totals: { entities: 0, cents: 0 },
        noun: "customer",
        divergences: allDivergences,
        untouched: acting.length,
      };
    }
  }

  emit({
    type: "plan",
    noun: "customer",
    stages: stages.map((st, i) => ({
      stage: i + 1,
      kind: i === 0 ? "canary" : "batch",
      references: st.map((t) => t.name),
    })),
  });

  let approvalId: string | null = null;
  let total = 0;
  let halted = false;
  let haltReason: string | undefined;
  const stageReports: StageReport[] = [];

  for (let i = 0; i < stages.length; i++) {
    const stageTargets = stages[i];
    const stageNo = i + 1;
    const kind: "canary" | "batch" = i === 0 ? "canary" : "batch";
    const references = stageTargets.map((t) => t.name);

    if (halted) {
      stageReports.push({
        stage: stageNo,
        kind,
        references,
        status: "not_reached",
        changed: {},
        divergences: [],
        refundIds: [],
      });
      continue;
    }

    emit({ type: "stage:start", stage: stageNo });

    const stageCtx: ActionCtx = { ...ctx, stage: stageNo };
    type PurgeWrite = { customers: number };
    type PurgeOutcome = { value: PurgeWrite; changes: AuditRow[]; approvalId?: string };

    const runStage = (fn: (tx: Tx) => Promise<PurgeWrite>): Promise<PurgeOutcome> =>
      approvalId === null
        ? executeFirstStage(args.runId, tokenHash, args.storedHash, fn)
        : executeStage(args.runId, approvalId, fn);

    const result = await runStage((tx) =>
      customerPurge.applyDbEffects(tx, stageCtx, stageTargets, args.params)
    );

    if (result.approvalId) approvalId = result.approvalId;
    total += result.value.customers;

    const compensation = buildCompensation(result.changes);
    const receiptId = await writeReceipt(args.runId, stageNo, result.changes, compensation, []);

    const post = await verifyAfterStage({
      targets: [],
      expectedCounts: expectedPurgeCounts(stageTargets, args.params),
      actualChanges: result.changes,
      refundIds: new Map(),
    });
    emit({
      type: "stage:verify",
      stage: stageNo,
      phase: "after",
      ok: worstDivergence(post) !== "critical",
      divergences: post,
    });

    if (worstDivergence(post) === "critical") {
      allDivergences.push(...post);
      await tripBreaker(args.runId, stageNo, post, "post-execution verification failed");
      halted = true;
      haltReason =
        "The rows that changed did not match what the simulation accounted for. Remaining stages were refused.";
    } else {
      await recordDivergences(args.runId, stageNo, post);
    }

    stageReports.push({
      stage: stageNo,
      kind,
      references,
      status: halted ? "halted" : "ok",
      changed: countByTable(result.changes),
      divergences: post,
      refundIds: [],
      receiptId,
    });

    emit({
      type: "stage:done",
      stage: stageNo,
      status: halted ? "halted" : "ok",
      changed: countByTable(result.changes),
      externalIds: [],
    });
    if (halted) emit({ type: "halted", stage: stageNo, reason: haltReason! });
  }

  if (!halted) {
    await sql`update preflight.runs set status = 'completed', updated_at = now() where id = ${args.runId}::uuid`;
  }

  return {
    runId: args.runId,
    status: halted ? "halted" : "completed",
    haltReason,
    stages: stageReports,
    totals: { entities: total, cents: 0 },
    noun: "customer",
    divergences: allDivergences,
    untouched: stageReports
      .filter((s) => s.status === "not_reached")
      .reduce((n, s) => n + s.references.length, 0),
  };
}

/**
 * Exactly how many rows a purge stage should touch. Unlike refunds, customers
 * carry different numbers of dependents, so this is summed per target rather
 * than scaled from a whole-plan total.
 */
function expectedPurgeCounts(
  targets: customerPurge.PurgeTarget[],
  params: PurgeParams
): Record<string, number> {
  if (params.strategy === "soft_archive") return { customers: targets.length };

  const sum = (f: (t: customerPurge.PurgeTarget) => number) =>
    targets.reduce((n, t) => n + f(t), 0);

  const counts: Record<string, number> = {
    customers: targets.length,
    orders: sum((t) => t.orderCount),
    ledger_entries: sum((t) => t.ledgerCount),
    notifications: sum((t) => t.notificationCount),
  };

  for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k];
  return counts;
}

// ---------------------------------------------------------------------------
// ROLLBACK
// ---------------------------------------------------------------------------

export type RollbackReport = {
  runId: string;
  receiptsApplied: number;
  rowsRestored: number;
  irreversible: ExternalEffect[];
};

/**
 * Undo the reversible half, honestly report the rest.
 *
 * Receipts are replayed newest-first, and each is single-use -- enforced by
 * preflight.open_gate_for_rollback, not by this loop.
 */
export async function rollback(runId: string): Promise<RollbackReport> {
  const sql = db();

  const receipts = await sql`
    select id, compensating, external_effects
      from preflight.receipts
     where run_id = ${runId}::uuid and applied = false
     order by stage desc`;

  let rowsRestored = 0;
  const irreversible: ExternalEffect[] = [];

  for (const r of receipts) {
    const steps = asJson<CompensationStep[]>(r.compensating);
    const out = await executeRollback(runId, String(r.id), (tx) => applyCompensation(tx, steps));
    rowsRestored += out.value;

    for (const e of asJson<ExternalEffect[]>(r.external_effects) ?? []) {
      if (!e.reversible) irreversible.push(e);
    }
  }

  await sql`update preflight.runs set status = 'rolled_back', updated_at = now() where id = ${runId}::uuid`;

  return { runId, receiptsApplied: receipts.length, rowsRestored, irreversible };
}
