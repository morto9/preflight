import { db, jsonb } from "@/lib/db";
import { readChargeTruths, stripeEnabled } from "@/lib/adapters/stripe";
import { money } from "@/lib/policy/invariants";
import type { RefundTarget } from "@/lib/actions/refund-bulk";
import type { AuditRow } from "@/lib/adapters/postgres";

/**
 * The safety net.
 *
 * A simulation is a forecast, and forecasts go stale. Between the moment an
 * operator approves a plan and the moment a stage runs, someone can issue a
 * refund straight from the Stripe dashboard, a webhook can fire, another
 * process can touch the same rows. No amount of simulation removes that window.
 *
 * So execution is staged, and every stage is checked against reality twice:
 * once before it acts, and once after.
 */

export type DivergenceKind =
  | "stripe_drift"
  | "row_count"
  | "amount_mismatch"
  | "external_failure";

export type Divergence = {
  kind: DivergenceKind;
  severity: "info" | "warn" | "critical";
  detail: string;
  predicted: unknown;
  actual: unknown;
};

/** What the simulation committed to, per order. */
export type Forecast = Record<string, { alreadyRefundedCents: number; refundCents: number }>;

/**
 * Before a stage acts: re-read the source of truth and confirm the forecast
 * still holds. Catching drift here means nothing irreversible has happened yet.
 *
 * The comparison is deliberately against the FORECAST rather than against the
 * freshly-resolved target. Execution re-reads Stripe before it begins, so
 * comparing a target against Stripe would be comparing Stripe to itself and
 * would never detect anything.
 */
export async function verifyBeforeStage(
  targets: RefundTarget[],
  forecast: Forecast
): Promise<Divergence[]> {
  const acting = targets.filter((t) => t.refundCents > 0 && t.chargeId);
  if (!stripeEnabled() || acting.length === 0) return [];

  const truths = await readChargeTruths(acting.map((t) => t.chargeId!));
  const divergences: Divergence[] = [];

  for (const t of acting) {
    const truth = truths.get(t.chargeId!);
    if (!truth) continue;

    if (truth.error) {
      divergences.push({
        kind: "external_failure",
        severity: "critical",
        detail: `Could not read charge for ${t.reference} from Stripe: ${truth.error}`,
        predicted: { refundable: money(t.refundCents) },
        actual: { error: truth.error },
      });
      continue;
    }

    const expected = forecast[t.orderId];
    if (!expected) {
      divergences.push({
        kind: "row_count",
        severity: "critical",
        detail: `${t.reference} was not part of the approved plan but now qualifies for it.`,
        predicted: { reference: t.reference, inPlan: false },
        actual: { reference: t.reference, wouldRefund: money(t.refundCents) },
      });
      continue;
    }

    if (truth.amountRefundedCents !== expected.alreadyRefundedCents) {
      const nowRefundable = Math.max(0, truth.amountCents - truth.amountRefundedCents);
      divergences.push({
        kind: "stripe_drift",
        severity: "critical",
        detail:
          `${t.reference}: this plan was approved on the basis that ` +
          `${money(expected.alreadyRefundedCents)} had been refunded, and forecast a ` +
          `${money(expected.refundCents)} refund. Stripe now reports ` +
          `${money(truth.amountRefundedCents)} refunded, leaving ${money(nowRefundable)} ` +
          `refundable. The charge changed after approval, so the forecast is stale.`,
        predicted: {
          reference: t.reference,
          alreadyRefunded: money(expected.alreadyRefundedCents),
          wouldRefund: money(expected.refundCents),
        },
        actual: {
          reference: t.reference,
          alreadyRefunded: money(truth.amountRefundedCents),
          stillRefundable: money(nowRefundable),
          driftedBy: money(truth.amountRefundedCents - expected.alreadyRefundedCents),
        },
      });
    }
  }

  return divergences;
}

/**
 * After a stage commits: confirm the world actually looks the way the forecast
 * said it would. This is what catches effects the simulation never modelled.
 */
export async function verifyAfterStage(args: {
  targets: RefundTarget[];
  /** Rows the simulation showed for this many orders, scaled to this stage. */
  expectedCounts: Record<string, number>;
  actualChanges: AuditRow[];
  refundIds: Map<string, string>;
}): Promise<Divergence[]> {
  const divergences: Divergence[] = [];
  const actual = countByTable(args.actualChanges);
  const tables = new Set([...Object.keys(args.expectedCounts), ...Object.keys(actual)]);

  for (const table of tables) {
    const p = args.expectedCounts[table] ?? 0;
    const a = actual[table] ?? 0;
    if (a === p) continue;

    // Touching MORE than forecast means an effect was never modelled, which is
    // the case worth halting for. Touching fewer is worth recording, not halting.
    divergences.push({
      kind: "row_count",
      severity: a > p ? "critical" : "warn",
      detail:
        a > p
          ? `preflight.${table}: the simulation accounted for ${p} row(s) in this stage but ` +
            `execution changed ${a}. Something wrote rows the forecast never modelled.`
          : `preflight.${table}: execution changed ${a} row(s) where ${p} were forecast.`,
      predicted: { table, rows: p },
      actual: { table, rows: a },
    });
  }

  // --- Does Stripe agree that the money moved as forecast? ------------------
  const acting = args.targets.filter((t) => t.refundCents > 0 && t.chargeId);
  if (stripeEnabled() && acting.length > 0) {
    const truths = await readChargeTruths(acting.map((t) => t.chargeId!));

    for (const t of acting) {
      const truth = truths.get(t.chargeId!);
      if (!truth || truth.error) continue;

      const expected = t.alreadyRefundedCents + t.refundCents;
      if (truth.amountRefundedCents !== expected) {
        divergences.push({
          kind: "amount_mismatch",
          severity: "critical",
          detail:
            `${t.reference}: expected Stripe to report ${money(expected)} refunded after this ` +
            `stage, but it reports ${money(truth.amountRefundedCents)}.`,
          predicted: { reference: t.reference, refunded: money(expected) },
          actual: { reference: t.reference, refunded: money(truth.amountRefundedCents) },
        });
      }
    }
  }

  return divergences;
}

function countByTable(changes: AuditRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) out[c.table_name] = (out[c.table_name] ?? 0) + 1;
  return out;
}

export function worstDivergence(ds: Divergence[]): "none" | "warn" | "critical" {
  if (ds.some((d) => d.severity === "critical")) return "critical";
  if (ds.length > 0) return "warn";
  return "none";
}

/**
 * Trip the breaker.
 *
 * Halting is not a `break` in a loop: it moves the run out of `executing`, and
 * Postgres refuses to open the gate for any further stage. The remaining work
 * becomes impossible rather than merely skipped.
 */
export async function tripBreaker(
  runId: string,
  stage: number,
  divergences: Divergence[],
  reason: string
): Promise<void> {
  const sql = db();

  for (const d of divergences) {
    await sql`
      insert into preflight.divergences
        (run_id, stage, kind, predicted, actual, detail, severity, halted)
      values (
        ${runId}::uuid, ${stage}, ${d.kind},
        ${jsonb(d.predicted)}, ${jsonb(d.actual)},
        ${d.detail}, ${d.severity}, true
      )`;
  }

  await sql`select preflight.halt_run(${runId}::uuid, ${reason})`;
}

/** Record divergences that did not warrant halting. */
export async function recordDivergences(
  runId: string,
  stage: number,
  divergences: Divergence[]
): Promise<void> {
  if (divergences.length === 0) return;
  const sql = db();

  for (const d of divergences) {
    await sql`
      insert into preflight.divergences
        (run_id, stage, kind, predicted, actual, detail, severity, halted)
      values (
        ${runId}::uuid, ${stage}, ${d.kind},
        ${jsonb(d.predicted)}, ${jsonb(d.actual)},
        ${d.detail}, ${d.severity}, false
      )`;
  }
}
