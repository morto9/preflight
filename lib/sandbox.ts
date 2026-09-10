import { db } from "@/lib/db";
import { withGate } from "@/lib/adapters/postgres";
import { createTestCharge, refundOutOfBand, stripeEnabled } from "@/lib/adapters/stripe";

/**
 * Per-visitor sandbox provisioning.
 *
 * Every visitor to the live demo gets an isolated tenant so that concurrent
 * reviewers never collide, and so "Reset sandbox" is always available.
 */

export { DEFECT_BATCH } from "@/lib/constants";
import { DEFECT_BATCH } from "@/lib/constants";

/**
 * The dataset is tuned so the demo contains a real decision.
 *
 * Refundable total across the defect batch is $2,365.00 against a $2,000.00
 * daily cap, so the obvious plan BLOCKS and the operator has to deselect rows
 * and re-simulate. Two orders are already partially refunded, so the forecast
 * has to read live state rather than assume amount == refundable.
 */
type SeedCustomer = {
  key: string;
  name: string;
  email: string;
  tier: "standard" | "pro" | "enterprise";
  unsubscribed?: boolean;
  lastOrderDaysAgo: number;
};

const CUSTOMERS: SeedCustomer[] = [
  { key: "ana", name: "Ana Ruiz", email: "ana@northwind.test", tier: "pro", lastOrderDaysAgo: 12 },
  { key: "ben", name: "Ben Okafor", email: "ben@northwind.test", tier: "standard", lastOrderDaysAgo: 14 },
  { key: "chloe", name: "Chloe Tan", email: "chloe@northwind.test", tier: "enterprise", lastOrderDaysAgo: 9 },
  { key: "dev", name: "Dev Patel", email: "dev@northwind.test", tier: "standard", unsubscribed: true, lastOrderDaysAgo: 15 },
  { key: "eli", name: "Eli Nakamura", email: "eli@northwind.test", tier: "pro", lastOrderDaysAgo: 11 },
  { key: "farah", name: "Farah Haddad", email: "farah@northwind.test", tier: "standard", lastOrderDaysAgo: 13 },
  { key: "greta", name: "Greta Lind", email: "greta@northwind.test", tier: "enterprise", lastOrderDaysAgo: 10 },
  // Dormant. Targets for the purge action.
  { key: "hugo", name: "Hugo Moreau", email: "hugo@northwind.test", tier: "standard", lastOrderDaysAgo: 1120 },
  { key: "ivy", name: "Ivy Chen", email: "ivy@northwind.test", tier: "standard", lastOrderDaysAgo: 1180 },
];

type SeedOrder = {
  ref: string;
  customer: string;
  amountCents: number;
  batch?: string;
  /** Pre-existing partial refund, mirrored into Stripe at provision time. */
  refundedCents?: number;
  daysAgo: number;
};

const ORDERS: SeedOrder[] = [
  // ---- the March defect batch: 14 orders, $2,485.00 captured ----------------
  { ref: "NW-1041", customer: "ana", amountCents: 18_500, batch: DEFECT_BATCH, daysAgo: 12 },
  { ref: "NW-1042", customer: "ben", amountCents: 24_000, batch: DEFECT_BATCH, daysAgo: 14 },
  { ref: "NW-1043", customer: "chloe", amountCents: 31_500, batch: DEFECT_BATCH, daysAgo: 9 },
  { ref: "NW-1044", customer: "dev", amountCents: 12_000, batch: DEFECT_BATCH, daysAgo: 15 },
  { ref: "NW-1045", customer: "eli", amountCents: 27_500, batch: DEFECT_BATCH, daysAgo: 11 },
  { ref: "NW-1046", customer: "farah", amountCents: 9_500, batch: DEFECT_BATCH, daysAgo: 13 },
  { ref: "NW-1047", customer: "greta", amountCents: 22_000, batch: DEFECT_BATCH, daysAgo: 10 },
  { ref: "NW-1048", customer: "ana", amountCents: 15_500, batch: DEFECT_BATCH, daysAgo: 12 },
  { ref: "NW-1049", customer: "ben", amountCents: 11_500, batch: DEFECT_BATCH, daysAgo: 14 },
  { ref: "NW-1050", customer: "chloe", amountCents: 19_500, batch: DEFECT_BATCH, daysAgo: 9 },
  { ref: "NW-1051", customer: "eli", amountCents: 14_000, batch: DEFECT_BATCH, daysAgo: 11 },
  { ref: "NW-1052", customer: "farah", amountCents: 17_500, batch: DEFECT_BATCH, daysAgo: 13 },
  // Already partially refunded, so refundable != captured.
  { ref: "NW-1053", customer: "greta", amountCents: 13_500, batch: DEFECT_BATCH, refundedCents: 4_000, daysAgo: 10 },
  { ref: "NW-1054", customer: "dev", amountCents: 12_000, batch: DEFECT_BATCH, refundedCents: 8_000, daysAgo: 15 },

  // ---- outside the batch: proves the selector actually selects -------------
  { ref: "NW-1020", customer: "ana", amountCents: 8_900, daysAgo: 40 },
  { ref: "NW-1021", customer: "chloe", amountCents: 45_000, daysAgo: 52 },
  { ref: "NW-1022", customer: "greta", amountCents: 16_400, daysAgo: 61 },
  { ref: "NW-0880", customer: "hugo", amountCents: 7_200, daysAgo: 1120 },
  { ref: "NW-0881", customer: "hugo", amountCents: 5_400, daysAgo: 1160 },
  { ref: "NW-0902", customer: "ivy", amountCents: 9_900, daysAgo: 1180 },
];

/** Ivy has a retained invoice, so deleting her raises a real FK violation. */
const INVOICES = [{ customer: "ivy", number: "INV-2023-0441", amountCents: 9_900 }];

export type ProvisionResult = {
  tenantId: string;
  stripeCharges: number;
  orders: number;
  customers: number;
};

export async function provisionTenant(
  tenantId: string,
  label = "demo sandbox"
): Promise<ProvisionResult> {
  const sql = db();

  // Tenant rows are control plane, not business writes, so they are ungated.
  await sql`
    insert into preflight.tenants (id, label)
    values (${tenantId}, ${label})
    on conflict (id) do update set last_seen_at = now()`;

  // Create the real Stripe charges up front, outside the transaction, so a slow
  // network call never holds a database transaction open.
  const useStripe = stripeEnabled();
  const charges = new Map<string, { paymentIntentId: string; chargeId: string }>();

  if (useStripe) {
    const refundable = ORDERS.filter((o) => o.batch === DEFECT_BATCH);
    const queue = [...refundable];
    const workers = Array.from({ length: Math.min(16, queue.length) }, async () => {
      for (let o = queue.shift(); o; o = queue.shift()) {
        try {
          const created = await createTestCharge(o.amountCents);
          // A pre-existing partial refund has to exist in Stripe as well, or the
          // sandbox starts life already drifted and every plan is blocked.
          if (o.refundedCents && o.refundedCents > 0) {
            await refundOutOfBand(created.chargeId, o.refundedCents);
          }
          charges.set(o.ref, created);
        } catch {
          // A charge that fails to create simply has no Stripe id; the UI will
          // show it as ledger-only rather than pretending otherwise.
        }
      }
    });
    await Promise.all(workers);
  }

  // Four statements rather than one per row. Provisioning happens while a
  // reviewer is watching a spinner, so the round trips matter.
  await withGate("seed", async (tx) => {
    const customerRows = await tx`
      insert into preflight.customers
        (tenant_id, email, name, tier, unsubscribed_at, last_order_at)
      select ${tenantId}, v.email, v.name, v.tier, v.unsub,
             now() - (v.days * interval '1 day')
        from unnest(
          ${CUSTOMERS.map((c) => c.email)}::text[],
          ${CUSTOMERS.map((c) => c.name)}::text[],
          ${CUSTOMERS.map((c) => c.tier)}::text[],
          ${CUSTOMERS.map((c) =>
            c.unsubscribed ? new Date(Date.now() - 30 * 86_400_000).toISOString() : null
          )}::timestamptz[],
          ${CUSTOMERS.map((c) => c.lastOrderDaysAgo)}::int[]
        ) as v(email, name, tier, unsub, days)
      returning id, email`;

    const idByEmail = new Map(customerRows.map((r) => [String(r.email), String(r.id)]));
    const customerId = (key: string) =>
      idByEmail.get(CUSTOMERS.find((c) => c.key === key)!.email)!;

    const statusOf = (o: SeedOrder) => {
      const r = o.refundedCents ?? 0;
      return r === 0 ? "paid" : r >= o.amountCents ? "refunded" : "partially_refunded";
    };

    const orderRows = await tx`
      insert into preflight.orders
        (tenant_id, customer_id, reference, stripe_payment_intent_id, stripe_charge_id,
         amount_cents, amount_refunded_cents, status, defect_batch, created_at)
      select ${tenantId}, v.customer_id, v.reference, v.pi, v.charge,
             v.amount, v.refunded, v.status, v.batch,
             now() - (v.days * interval '1 day')
        from unnest(
          ${ORDERS.map((o) => customerId(o.customer))}::uuid[],
          ${ORDERS.map((o) => o.ref)}::text[],
          ${ORDERS.map((o) => charges.get(o.ref)?.paymentIntentId ?? null)}::text[],
          ${ORDERS.map((o) => charges.get(o.ref)?.chargeId ?? null)}::text[],
          ${ORDERS.map((o) => o.amountCents)}::int[],
          ${ORDERS.map((o) => o.refundedCents ?? 0)}::int[],
          ${ORDERS.map(statusOf)}::text[],
          ${ORDERS.map((o) => o.batch ?? null)}::text[],
          ${ORDERS.map((o) => o.daysAgo)}::int[]
        ) as v(customer_id, reference, pi, charge, amount, refunded, status, batch, days)
      returning id, reference`;

    const orderId = new Map(orderRows.map((r) => [String(r.reference), String(r.id)]));

    const ledger = ORDERS.flatMap((o) => {
      const rows = [
        { id: orderId.get(o.ref)!, kind: "charge", amount: o.amountCents, memo: `Captured ${o.ref}` },
      ];
      if (o.refundedCents) {
        rows.push({
          id: orderId.get(o.ref)!,
          kind: "refund",
          amount: -o.refundedCents,
          memo: "Earlier partial refund",
        });
      }
      return rows;
    });

    await tx`
      insert into preflight.ledger_entries (tenant_id, order_id, kind, amount_cents, memo)
      select ${tenantId}, v.order_id, v.kind, v.amount, v.memo
        from unnest(
          ${ledger.map((l) => l.id)}::uuid[],
          ${ledger.map((l) => l.kind)}::text[],
          ${ledger.map((l) => l.amount)}::int[],
          ${ledger.map((l) => l.memo)}::text[]
        ) as v(order_id, kind, amount, memo)`;

    await tx`
      insert into preflight.invoices (tenant_id, customer_id, number, amount_cents)
      select ${tenantId}, v.customer_id, v.number, v.amount
        from unnest(
          ${INVOICES.map((i) => customerId(i.customer))}::uuid[],
          ${INVOICES.map((i) => i.number)}::text[],
          ${INVOICES.map((i) => i.amountCents)}::int[]
        ) as v(customer_id, number, amount)`;
  });

  return {
    tenantId,
    stripeCharges: charges.size,
    orders: ORDERS.length,
    customers: CUSTOMERS.length,
  };
}

/**
 * Wipe and re-provision. Deleting the tenant cascades through every business
 * table, which fires the gate, so this needs the gate open like any other write.
 */
export async function resetTenant(tenantId: string, label?: string): Promise<ProvisionResult> {
  await withGate("seed", async (tx) => {
    await tx`delete from preflight.tenants where id = ${tenantId}`;
  });
  return provisionTenant(tenantId, label ?? "demo sandbox");
}
