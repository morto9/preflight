import { NextResponse } from "next/server";
import { db, asJson } from "@/lib/db";
import { refundOutOfBand, stripeEnabled } from "@/lib/adapters/stripe";
import { currentTenant } from "@/lib/session";
import { money } from "@/lib/policy/invariants";
import type { SimulationReport } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The failure-test trigger.
 *
 * Issues a refund against the first order this plan intends to touch, directly
 * in Stripe, exactly as a support agent clicking around the dashboard would.
 * The approved forecast is now stale, and nothing in our database knows it.
 */
export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  if (!stripeEnabled()) {
    return NextResponse.json(
      { error: "Stripe is not configured, so out-of-band drift cannot be injected." },
      { status: 400 }
    );
  }

  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });

  const sql = db();
  const [run] = await sql`
    select simulation from preflight.runs
     where id = ${runId}::uuid and tenant_id = ${tenantId}`;
  if (!run?.simulation) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  const sim = asJson<SimulationReport>(run.simulation);
  const first = sim.impacts.find((i) => !i.skipped);
  if (!first) return NextResponse.json({ error: "This plan touches nothing." }, { status: 400 });

  const [order] = await sql`
    select reference, stripe_charge_id, amount_cents, amount_refunded_cents
      from preflight.orders where id = ${first.id}::uuid`;

  if (!order?.stripe_charge_id) {
    return NextResponse.json(
      { error: "That order has no Stripe charge behind it." },
      { status: 400 }
    );
  }

  const headroom = Number(order.amount_cents) - Number(order.amount_refunded_cents);
  const amount = Math.max(100, Math.min(1_500, Math.floor(headroom / 4)));

  const out = await refundOutOfBand(String(order.stripe_charge_id), amount);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 502 });

  return NextResponse.json({
    reference: String(order.reference),
    amountCents: amount,
    refundId: out.refundId,
    message:
      `A support agent just refunded ${money(amount)} of ${order.reference} straight from the ` +
      `Stripe dashboard. Our database still believes nothing has changed, and the approved ` +
      `plan is now built on a stale reading.`,
  });
}
