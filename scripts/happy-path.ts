import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { simulate, execute, rollback } from "@/lib/gateway";
import { createApproval } from "@/lib/gateway/approval";
import { DEFECT_BATCH, resetTenant } from "@/lib/sandbox";
import { money } from "@/lib/policy/invariants";
import { ActionPlan } from "@/lib/plan/schema";
import { readChargeTruths } from "@/lib/adapters/stripe";
import { db } from "@/lib/db";

/**
 * The full cycle with nothing going wrong:
 * simulate -> blocked -> tweak -> re-simulate -> approve -> execute -> roll back.
 */

const TENANT = process.env.SEED_TENANT ?? "demo";

async function main() {
  const sql = db();

  console.log("=== 0. RESET SANDBOX ===");
  const seeded = await resetTenant(TENANT, "happy path");
  console.log(`${seeded.orders} orders, ${seeded.stripeCharges} real Stripe charges`);

  const basePlan = {
    tool: "refund.bulk" as const,
    params: {
      selector: { defectBatch: DEFECT_BATCH },
      mode: "full" as const,
      reason: "requested_by_customer" as const,
      excludeOrderIds: [] as string[],
      dailyCapCents: 200_000,
    },
  };

  // --- 1. The obvious plan, which is over the ceiling ----------------------
  console.log("\n=== 1. SIMULATE the obvious plan ===");
  const first = await simulate({
    tenantId: TENANT,
    plan: ActionPlan.parse(basePlan),
    intent: "refund everyone hit by the March defect batch",
  });
  console.log(`verdict=${first.verdict}  ${first.summary.acting} orders  ${money(first.summary.moneyCents)}`);
  const blocker = first.invariants.find((i) => i.severity === "block");
  console.log(`blocked by: ${blocker?.label}`);
  console.log(`  ${blocker?.detail}`);
  console.log(`  remedy offered: ${blocker?.remedy?.label}`);

  // --- 2. Apply the offered remedy and re-simulate -------------------------
  console.log("\n=== 2. TWEAK (apply the remedy) and RE-SIMULATE ===");
  const tweaked = ActionPlan.parse({
    ...basePlan,
    params: { ...basePlan.params, ...(blocker?.remedy?.patch ?? {}) },
  });
  const second = await simulate({ tenantId: TENANT, plan: tweaked, intent: "…minus the largest refunds" });
  console.log(`verdict=${second.verdict}  ${second.summary.acting} orders  ${money(second.summary.moneyCents)}`);
  console.log(`plan hash changed: ${first.planHash.slice(0, 12)} -> ${second.planHash.slice(0, 12)}`);

  if (second.verdict !== "ready") {
    console.log("still blocked:", second.invariants.filter((i) => i.severity === "block"));
    await sql.end();
    return;
  }

  // --- 3. Approve and execute ---------------------------------------------
  console.log("\n=== 3. APPROVE + EXECUTE ===");
  const grant = await createApproval({ runId: second.runId, planHash: second.planHash });
  const exec = await execute({ runId: second.runId, token: grant.token });

  console.log(`status=${exec.status}`);
  console.log(`refunded ${exec.totals.orders} order(s), ${money(exec.totals.cents)}`);
  for (const s of exec.stages) {
    console.log(`  stage ${s.stage} ${s.kind.padEnd(6)} ${s.status.padEnd(11)} ${s.refundIds.length} stripe refund(s)`);
  }
  if (exec.divergences.length) console.log("divergences:", exec.divergences);

  // --- 4. Confirm against Stripe itself ------------------------------------
  console.log("\n=== 4. CONFIRM IN STRIPE ===");
  const rows = await sql`
    select reference, stripe_charge_id, amount_cents, amount_refunded_cents
      from preflight.orders
     where tenant_id = ${TENANT} and stripe_charge_id is not null
     order by reference limit 4`;
  const truths = await readChargeTruths(rows.map((r) => String(r.stripe_charge_id)));
  for (const r of rows) {
    const t = truths.get(String(r.stripe_charge_id))!;
    const agree = t.amountRefundedCents === Number(r.amount_refunded_cents);
    console.log(
      `  ${r.reference}  db=${money(Number(r.amount_refunded_cents))}  ` +
        `stripe=${money(t.amountRefundedCents)}  ${agree ? "agree" : "DISAGREE"}`
    );
  }

  // --- 5. Roll back ---------------------------------------------------------
  console.log("\n=== 5. ROLL BACK ===");
  const rb = await rollback(second.runId);
  console.log(`applied ${rb.receiptsApplied} receipt(s), restored ${rb.rowsRestored} row(s)`);
  console.log(`irreversible external effects: ${rb.irreversible.length}`);
  if (rb.irreversible[0]) console.log(`  e.g. ${rb.irreversible[0].note}`);

  const after = await sql`
    select coalesce(sum(amount_refunded_cents),0)::int as refunded,
           (select count(*) from preflight.refunds where tenant_id = ${TENANT})::int as refund_rows
      from preflight.orders where tenant_id = ${TENANT}`;
  console.log(
    `\nafter rollback: orders.amount_refunded total = ${money(after[0].refunded)}, ` +
      `refund rows = ${after[0].refund_rows}`
  );
  console.log("(the $120.00 is the seeded pre-existing partial refunds, correctly left alone)");

  await sql.end();
}

main().catch(async (e) => {
  console.error("\nhappy-path errored:", e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});
