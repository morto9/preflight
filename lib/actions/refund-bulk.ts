import type postgres from "postgres";
import type { Tx } from "@/lib/adapters/postgres";
import type { ActionCtx, ExternalEffect, Impact } from "@/lib/actions/types";
import type { RefundBulkParams } from "@/lib/plan/schema";
import { z } from "zod";
import { readChargeTruths, stripeEnabled } from "@/lib/adapters/stripe";
import { money } from "@/lib/policy/invariants";

type Params = z.infer<typeof RefundBulkParams>;

export type RefundTarget = {
  orderId: string;
  reference: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  amountCents: number;
  currency: string;
  chargeId: string | null;
  /** What our database believes has been refunded. */
  mirrorRefundedCents: number;
  /** What Stripe says has been refunded. Null when Stripe is unavailable. */
  truthRefundedCents: number | null;
  /** truth - mirror. Non-zero means our forecast is built on stale data. */
  driftCents: number;
  /** Best available truth. */
  alreadyRefundedCents: number;
  /** What this plan would refund. */
  refundCents: number;
  excluded: boolean;
  excludeReason?: string;
};

/**
 * Selector -> concrete rows. Read-only, and deliberately run outside any
 * transaction so the Stripe reconciliation that follows never holds one open.
 */
export async function resolveTargets(
  sql: postgres.Sql,
  ctx: ActionCtx,
  params: Params
): Promise<RefundTarget[]> {
  const s = params.selector;

  const rows = await sql`
    select
      o.id, o.reference, o.amount_cents, o.amount_refunded_cents,
      o.stripe_charge_id, o.currency,
      c.id as customer_id, c.name as customer_name, c.email as customer_email
    from preflight.orders o
    join preflight.customers c on c.id = o.customer_id
    where o.tenant_id = ${ctx.tenantId}
      and c.archived_at is null
      ${s.defectBatch ? sql`and o.defect_batch = ${s.defectBatch}` : sql``}
      ${s.orderIds?.length ? sql`and o.id = any(${s.orderIds}::uuid[])` : sql``}
      ${s.createdBefore ? sql`and o.created_at < ${s.createdBefore}::timestamptz` : sql``}
      ${s.minAmountCents != null ? sql`and o.amount_cents >= ${s.minAmountCents}` : sql``}
    order by o.reference`;

  const excluded = new Set(params.excludeOrderIds);

  return rows.map((r) => {
    const orderId = String(r.id);
    return {
      orderId,
      reference: String(r.reference),
      customerId: String(r.customer_id),
      customerName: String(r.customer_name),
      customerEmail: String(r.customer_email),
      amountCents: Number(r.amount_cents),
      currency: String(r.currency),
      chargeId: r.stripe_charge_id ? String(r.stripe_charge_id) : null,
      mirrorRefundedCents: Number(r.amount_refunded_cents),
      truthRefundedCents: null,
      driftCents: 0,
      alreadyRefundedCents: Number(r.amount_refunded_cents),
      refundCents: 0,
      excluded: excluded.has(orderId),
      excludeReason: excluded.has(orderId) ? "deselected by operator" : undefined,
    };
  });
}

/**
 * Ask Stripe what is actually true, and compute how far our cached mirror has
 * drifted from it. This is the difference between forecasting from our own
 * records and forecasting from the system that will actually be changed.
 */
export async function reconcileWithStripe(targets: RefundTarget[]): Promise<RefundTarget[]> {
  if (!stripeEnabled()) return targets;

  const chargeIds = targets.map((t) => t.chargeId).filter((c): c is string => Boolean(c));
  if (chargeIds.length === 0) return targets;

  const truths = await readChargeTruths(chargeIds);

  return targets.map((t) => {
    if (!t.chargeId) return t;
    const truth = truths.get(t.chargeId);
    if (!truth || truth.error) return t;

    return {
      ...t,
      truthRefundedCents: truth.amountRefundedCents,
      driftCents: truth.amountRefundedCents - t.mirrorRefundedCents,
      alreadyRefundedCents: truth.amountRefundedCents,
    };
  });
}

/** Decide the refund amount per target, given the plan's mode. */
export function priceTargets(targets: RefundTarget[], params: Params): RefundTarget[] {
  return targets.map((t) => {
    if (t.excluded) return { ...t, refundCents: 0 };

    const remaining = Math.max(0, t.amountCents - t.alreadyRefundedCents);
    const wanted =
      params.mode === "full"
        ? remaining
        : Math.round((t.amountCents * (params.partialPercent ?? 100)) / 100);

    return { ...t, refundCents: Math.min(wanted, remaining) };
  });
}

export function idempotencyKey(runId: string, orderId: string): string {
  return `preflight:${runId}:${orderId}`;
}

/**
 * The database half of the write.
 *
 * This exact function runs during simulation (inside a transaction that rolls
 * back) and during execution (inside a transaction that commits). Nothing about
 * it branches on mode, which is why the diff shown to the operator is a preview
 * rather than a description of one.
 */
export async function applyDbEffects(
  tx: Tx,
  ctx: ActionCtx,
  targets: RefundTarget[],
  params: Params,
  refundIds: Map<string, string> = new Map()
): Promise<{ orders: number; cents: number }> {
  const acting = targets.filter((t) => t.refundCents > 0);
  if (acting.length === 0) return { orders: 0, cents: 0 };

  // Set-based rather than row-by-row: three statements regardless of batch size.
  // The per-row audit trigger still fires for every affected row, so the blast
  // radius stays fully observable.
  const ids = acting.map((t) => t.orderId);
  const amounts = acting.map((t) => t.refundCents);
  const externalIds = acting.map((t) => refundIds.get(t.orderId) ?? null);
  const memos = acting.map((t) => `Refund ${t.reference} (${params.reason})`);

  await tx`
    update preflight.orders o
       set amount_refunded_cents = o.amount_refunded_cents + v.refund_cents,
           status = case
             when o.amount_refunded_cents + v.refund_cents >= o.amount_cents then 'refunded'
             else 'partially_refunded'
           end
      from unnest(${ids}::uuid[], ${amounts}::int[]) as v(id, refund_cents)
     where o.id = v.id`;

  await tx`
    insert into preflight.refunds
      (tenant_id, order_id, stripe_refund_id, amount_cents, status, reason, run_id)
    select ${ctx.tenantId}, v.id, v.external_id, v.refund_cents,
           'succeeded', ${params.reason}, ${ctx.runId}::uuid
      from unnest(${ids}::uuid[], ${amounts}::int[], ${externalIds}::text[])
             as v(id, refund_cents, external_id)`;

  await tx`
    insert into preflight.ledger_entries
      (tenant_id, order_id, kind, amount_cents, memo, run_id)
    select ${ctx.tenantId}, v.id, 'refund', -v.refund_cents, v.memo, ${ctx.runId}::uuid
      from unnest(${ids}::uuid[], ${amounts}::int[], ${memos}::text[])
             as v(id, refund_cents, memo)`;

  return { orders: acting.length, cents: amounts.reduce((s, n) => s + n, 0) };
}

/** Row-level before/after for the diff view. */
export function buildImpacts(targets: RefundTarget[]): Impact[] {
  return targets.map((t) => {
    const after = t.alreadyRefundedCents + t.refundCents;
    return {
      id: t.orderId,
      label: t.reference,
      who: `${t.customerName} <${t.customerEmail}>`,
      from: money(t.alreadyRefundedCents),
      to: money(after),
      delta: t.refundCents > 0 ? `+${money(t.refundCents)}` : "—",
      amountCents: t.refundCents,
      before: {
        status: statusFor(t.alreadyRefundedCents, t.amountCents),
        refunded: money(t.alreadyRefundedCents),
        balance: money(t.amountCents - t.alreadyRefundedCents),
      },
      after: {
        status: statusFor(after, t.amountCents),
        refunded: money(after),
        balance: money(t.amountCents - after),
      },
      skipped: t.excluded
        ? t.excludeReason
        : t.refundCents <= 0
          ? "nothing left to refund"
          : undefined,
    };
  });
}

function statusFor(refunded: number, amount: number): string {
  if (refunded <= 0) return "paid";
  return refunded >= amount ? "refunded" : "partially_refunded";
}

/** Effects that land in Stripe, which we cannot roll back. */
export function externalEffects(targets: RefundTarget[]): ExternalEffect[] {
  return targets
    .filter((t) => t.refundCents > 0 && t.chargeId)
    .map((t) => ({
      system: "stripe" as const,
      kind: "refund.create",
      target: t.chargeId!,
      amountCents: t.refundCents,
      reversible: false,
      note: `${money(t.refundCents)} to ${t.customerName}. A completed Stripe refund cannot be reversed.`,
    }));
}

/** Refunds already issued today, which count against the daily ceiling. */
export async function spentToday(sql: postgres.Sql, tenantId: string): Promise<number> {
  const [row] = await sql`
    select coalesce(sum(amount_cents), 0) as total
      from preflight.refunds
     where tenant_id = ${tenantId}
       and created_at >= date_trunc('day', now())`;
  return Number(row.total);
}
