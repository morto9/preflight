import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { simulate, execute, rollback } from "@/lib/gateway";
import { createApproval } from "@/lib/gateway/approval";
import { DEFECT_BATCH, resetTenant } from "@/lib/sandbox";
import { money } from "@/lib/policy/invariants";
import { ActionPlan } from "@/lib/plan/schema";
import { refundOutOfBand } from "@/lib/adapters/stripe";
import { db } from "@/lib/db";

/**
 * The failure test.
 *
 * A simulation is a forecast made at a moment in time. Between approval and
 * execution somebody issues a refund straight from the Stripe dashboard -- the
 * most ordinary thing a support agent does. The forecast is now wrong, and no
 * amount of simulating would have prevented that.
 *
 * This script proves the safety net catches it.
 */

const TENANT = process.env.SEED_TENANT ?? "demo";

async function main() {
  const sql = db();

  // Fresh sandbox: drift injected by an earlier run would otherwise be caught
  // at simulate time, and the point here is to inject it AFTER approval.
  console.log("=== 0. RESET SANDBOX (creates fresh Stripe charges) ===");
  const seeded = await resetTenant(TENANT, "failure test");
  console.log(`${seeded.orders} orders, ${seeded.stripeCharges} real Stripe charges`);

  const plan = ActionPlan.parse({
    tool: "refund.bulk",
    params: {
      selector: { defectBatch: DEFECT_BATCH },
      mode: "full",
      reason: "requested_by_customer",
      excludeOrderIds: [],
      dailyCapCents: 1_000_000, // deliberately generous so the plan passes
    },
  });

  console.log("\n=== 1. SIMULATE ===");
  const sim = await simulate({ tenantId: TENANT, plan, intent: "refund the March defect batch" });
  console.log(`verdict=${sim.verdict}  orders=${sim.summary.acting}  total=${money(sim.summary.moneyCents)}`);
  console.log(`stripe drift detected at simulate time: ${sim.stripe.drifted}`);

  if (sim.verdict !== "ready") {
    console.log("Plan is blocked, cannot continue:", sim.invariants.filter((i) => i.severity === "block"));
    await sql.end();
    return;
  }

  console.log("\n=== 2. APPROVE ===");
  const grant = await createApproval({ runId: sim.runId, planHash: sim.planHash });
  console.log(`approval ${grant.approvalId} expires ${grant.expiresAt}`);

  // --- 3. The world changes underneath the approved plan -------------------
  console.log("\n=== 3. INJECT DRIFT (out-of-band Stripe refund) ===");
  const canary = sim.impacts.find((i) => !i.skipped)!;
  const [row] = await sql`
    select stripe_charge_id, amount_cents, reference
      from preflight.orders where id = ${canary.id}::uuid`;

  const nibble = 1_500; // $15.00 refunded by "a support agent"
  const out = await refundOutOfBand(String(row.stripe_charge_id), nibble);
  console.log(
    out.ok
      ? `Someone refunded ${money(nibble)} of ${row.reference} directly in Stripe (${out.refundId}).`
      : `Could not inject drift: ${out.error}`
  );
  console.log("Our database still believes nothing has changed.");

  // --- 4. Execute against the now-stale forecast ---------------------------
  console.log("\n=== 4. EXECUTE ===");
  const exec = await execute({ runId: sim.runId, token: grant.token });

  console.log(`status=${exec.status}`);
  if (exec.haltReason) console.log(`halt reason: ${exec.haltReason}`);
  console.log(`refunded: ${exec.totals.orders} order(s), ${money(exec.totals.cents)}`);
  console.log(`orders never touched: ${exec.untouched}`);

  console.log("\nstages:");
  for (const s of exec.stages) {
    console.log(`  ${s.stage} ${s.kind.padEnd(6)} ${s.status.padEnd(11)} ${s.references.join(", ")}`);
  }

  console.log("\ndivergences:");
  for (const d of exec.divergences) {
    console.log(`  [${d.severity}] ${d.kind}`);
    console.log(`    ${d.detail}`);
  }

  // --- 5. What the database now says about the run -------------------------
  const [runRow] = await sql`select status from preflight.runs where id = ${sim.runId}::uuid`;
  console.log(`\nrun status in database: ${runRow.status}`);

  const refunded = await sql`
    select count(*)::int as n, coalesce(sum(amount_cents),0)::int as cents
      from preflight.refunds where run_id = ${sim.runId}::uuid`;
  console.log(
    `refund rows actually written: ${refunded[0].n} (${money(refunded[0].cents)})`
  );

  // Prove further stages are impossible, not merely skipped.
  console.log("\n=== 5. IS THE BREAKER REAL? ===");
  try {
    await sql`select preflight.open_gate_for_stage(${sim.runId}::uuid, ${grant.approvalId}::uuid)`;
    console.log("  UNEXPECTED: the gate opened for another stage.");
  } catch (e) {
    console.log(`  Postgres refuses another stage: ${(e as Error).message.split("\n")[0]}`);
  }

  await sql.end();
}

main().catch(async (e) => {
  console.error("\nfailure-test errored:", e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});
