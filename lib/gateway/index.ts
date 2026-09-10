import { db, asJson, type PgFailure } from "@/lib/db";
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

export type Consequences = {
  source: "gemini" | "rules";
  confidence: number;
  impacted: string[];
  sideEffects: string[];
  watchFor: string[];
  summary: string;
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
    values (${args.tenantId}, ${args.intent ?? null}, ${JSON.stringify(plan)}::jsonb, ${hash}, 'simulated')
    returning id, created_at`;

  const runId = String(runRow.id);
  const ctx: ActionCtx = { tenantId: args.tenantId, runId, mode: "simulate", stage: 0 };

  if (plan.tool !== "refund.bulk") {
    throw new Error(`preflight: tool ${plan.tool} is not wired into the gateway yet`);
  }

  // 1. Resolve the selector against real rows, then ask Stripe what is true.
  let targets = await refundBulk.resolveTargets(sql, ctx, plan.params);
  targets = await refundBulk.reconcileWithStripe(targets);
  targets = refundBulk.priceTargets(targets, plan.params);

  // 2. Perform the write for real, inside a transaction that rolls back.
  const run = await dryRun((tx) => refundBulk.applyDbEffects(tx, ctx, targets, plan.params));

  // 3. Assert policy against the state the database actually reached.
  const spent = await refundBulk.spentToday(sql, args.tenantId);
  const invariants = refundInvariants({
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
    dailyCapCents: plan.params.dailyCapCents,
    spentTodayCents: spent,
  });

  if (run.failure) {
    invariants.unshift({
      id: "database_refused",
      label: "The database refused this write",
      severity: "block",
      detail: `${run.failure.message}${run.failure.detail ? ` -- ${run.failure.detail}` : ""}`,
      evidence: { code: run.failure.code, constraint: run.failure.constraint },
    });
  }

  // 4. Derive the rollback path from the pre-images just captured.
  const compensation = buildCompensation(run.changes);
  const external = refundBulk.externalEffects(targets);
  const acting = targets.filter((t) => t.refundCents > 0);

  const report: SimulationReport = {
    runId,
    tool: plan.tool,
    planHash: hash,
    intent: args.intent,
    createdAt: new Date(runRow.created_at as string).toISOString(),
    summary: {
      matched: targets.length,
      acting: acting.length,
      skipped: targets.length - acting.length,
      moneyCents: acting.reduce((s, t) => s + t.refundCents, 0),
    },
    impacts: refundBulk.buildImpacts(targets),
    proven: {
      changeCount: run.changes.length,
      tableCounts: countByTable(run.changes),
      unnamedEffects: unnamedEffects(run.changes),
      failure: run.failure,
    },
    invariants,
    verdict: worstSeverity(invariants) === "block" ? "blocked" : "ready",
    external,
    rollback: {
      ...describeCompensation(compensation),
      steps: compensation.length,
      irreversible: external.filter((e) => !e.reversible),
    },
    stripe: {
      enabled: stripeEnabled(),
      charges: targets.filter((t) => t.chargeId).length,
      drifted: targets.filter((t) => t.driftCents !== 0).length,
    },
    forecast: Object.fromEntries(
      targets.map((t) => [
        t.orderId,
        { alreadyRefundedCents: t.alreadyRefundedCents, refundCents: t.refundCents },
      ])
    ),
  };

  await sql`
    update preflight.runs
       set simulation = ${JSON.stringify(report)}::jsonb, updated_at = now()
     where id = ${runId}::uuid`;

  return report;
}

function countByTable(changes: AuditRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) out[c.table_name] = (out[c.table_name] ?? 0) + 1;
  return out;
}

/**
 * Tables the plan never mentions but nonetheless changed. This is the part of
 * a blast radius that people are usually surprised by.
 */
function unnamedEffects(changes: AuditRow[]): { table: string; rows: number }[] {
  const named = new Set(["orders", "refunds"]);
  return Object.entries(countByTable(changes))
    .filter(([t]) => !named.has(t))
    .map(([table, rows]) => ({ table, rows }));
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

export type ExecutionReport = {
  runId: string;
  status: "completed" | "halted";
  haltReason?: string;
  stages: StageReport[];
  totals: { orders: number; cents: number };
  divergences: Divergence[];
  untouched: number;
};

export async function execute(args: {
  runId: string;
  token: string;
}): Promise<ExecutionReport> {
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
  if (plan.tool !== "refund.bulk") {
    throw new Error(`preflight: tool ${plan.tool} is not wired into the gateway yet`);
  }

  // A halted or finished run is terminal. Re-running it would be a second bite
  // at an approval the operator granted once.
  const runStatus = String(runRow.status);
  if (runStatus !== "simulated") {
    throw new Error(
      `preflight: run is "${runStatus}"; only a simulated, approved run can be executed`
    );
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
      totals: { orders: 0, cents: 0 },
      divergences: allDivergences,
      untouched: acting.length,
    };
  }

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

    // --- (a) Is the forecast still true? Check BEFORE anything irreversible.
    const pre = await verifyBeforeStage(stageTargets, forecast);
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
    totals: { orders: totalOrders, cents: totalCents },
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
      ${JSON.stringify(changes)}::jsonb,
      ${JSON.stringify(compensation)}::jsonb,
      ${JSON.stringify(external)}::jsonb
    )
    returning id`;
  return String(row.id);
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
