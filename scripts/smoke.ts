import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { simulate } from "@/lib/gateway";
import { DEFECT_BATCH } from "@/lib/sandbox";
import { money } from "@/lib/policy/invariants";
import { ActionPlan } from "@/lib/plan/schema";
import { db } from "@/lib/db";

/**
 * A command-line walk through one simulation, so the gateway can be exercised
 * without the UI.
 */

const TENANT = process.env.SEED_TENANT ?? "demo";

async function main() {
  const plan = ActionPlan.parse({
    tool: "refund.bulk",
    params: {
      selector: { defectBatch: DEFECT_BATCH },
      mode: "full",
      reason: "requested_by_customer",
      excludeOrderIds: [],
      dailyCapCents: 200_00 * 10,
    },
  });

  console.log(`\nIntent: refund every order hit by the ${DEFECT_BATCH} defect batch\n`);

  const t0 = Date.now();
  const r = await simulate({ tenantId: TENANT, plan, intent: "refund the March defect batch" });
  const ms = Date.now() - t0;

  console.log(`run ${r.runId}   plan ${r.planHash.slice(0, 12)}   ${ms}ms`);
  console.log(`VERDICT: ${r.verdict.toUpperCase()}`);
  console.log(
    `matched ${r.summary.matched} orders, acting on ${r.summary.acting}, ` +
      `skipping ${r.summary.skipped}, total ${money(r.summary.moneyCents)}\n`
  );

  console.log("PROVEN (real write, rolled back)");
  console.log(`  ${r.proven.changeCount} rows changed across:`, r.proven.tableCounts);
  if (r.proven.unnamedEffects.length) {
    console.log("  effects the plan never named:", r.proven.unnamedEffects);
  }
  if (r.proven.failure) console.log("  database refused:", r.proven.failure.message);

  console.log("\nINVARIANTS");
  for (const i of r.invariants) {
    const mark = i.severity === "block" ? "BLOCK" : i.severity === "warn" ? " warn" : "   ok";
    console.log(`  [${mark}] ${i.label}`);
    console.log(`          ${i.detail}`);
    if (i.remedy) console.log(`          remedy: ${i.remedy.label}`);
  }

  console.log("\nSTRIPE");
  console.log(
    `  enabled=${r.stripe.enabled} charges=${r.stripe.charges} drifted=${r.stripe.drifted}`
  );

  console.log("\nROLLBACK PATH");
  console.log(`  ${r.rollback.steps} compensating step(s)`, r.rollback.byTable);
  console.log(`  irreversible external effects: ${r.rollback.irreversible.length}`);

  console.log("\nDIFF (first 6)");
  for (const i of r.impacts.slice(0, 6)) {
    const tag = i.skipped ? `  SKIP (${i.skipped})` : "";
    console.log(
      `  ${i.label}  ${i.before.refunded} -> ${i.after.refunded}   ` +
        `${i.before.status} -> ${i.after.status}${tag}`
    );
  }

  await db().end();
}

main().catch(async (e) => {
  console.error("\nsmoke failed:", e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});
