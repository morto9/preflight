import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentTenant } from "@/lib/session";
import { stripeEnabled } from "@/lib/adapters/stripe";
import { geminiEnabled } from "@/lib/llm/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current sandbox state: what the operator is looking at before acting. */
export async function GET() {
  const tenantId = await currentTenant();
  if (!tenantId) {
    return NextResponse.json({
      provisioned: false,
      stripe: stripeEnabled(),
      gemini: geminiEnabled(),
    });
  }

  const sql = db();

  const [orders, totals, runs] = await Promise.all([
    sql`
      select o.id, o.reference, o.amount_cents, o.amount_refunded_cents, o.status,
             o.defect_batch, o.stripe_charge_id, c.name as customer_name, c.email
        from preflight.orders o
        join preflight.customers c on c.id = o.customer_id
       where o.tenant_id = ${tenantId}
       order by o.reference`,
    sql`
      select
        count(*)::int as orders,
        coalesce(sum(amount_cents), 0)::int as captured,
        coalesce(sum(amount_refunded_cents), 0)::int as refunded
      from preflight.orders where tenant_id = ${tenantId}`,
    sql`
      select id, intent, plan_hash, status, created_at
        from preflight.runs where tenant_id = ${tenantId}
       order by created_at desc limit 8`,
  ]);

  return NextResponse.json({
    provisioned: true,
    tenantId,
    stripe: stripeEnabled(),
    gemini: geminiEnabled(),
    totals: totals[0],
    orders: orders.map((o) => ({
      id: String(o.id),
      reference: String(o.reference),
      amountCents: Number(o.amount_cents),
      refundedCents: Number(o.amount_refunded_cents),
      status: String(o.status),
      defectBatch: o.defect_batch ? String(o.defect_batch) : null,
      hasCharge: Boolean(o.stripe_charge_id),
      customer: String(o.customer_name),
      email: String(o.email),
    })),
    runs: runs.map((r) => ({
      id: String(r.id),
      intent: r.intent ? String(r.intent) : null,
      planHash: String(r.plan_hash),
      status: String(r.status),
      createdAt: new Date(r.created_at as string).toISOString(),
    })),
  });
}
