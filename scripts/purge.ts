import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { simulate, execute, rollback } from "@/lib/gateway";
import { createApproval } from "@/lib/gateway/approval";
import { resetTenant } from "@/lib/sandbox";
import { ActionPlan } from "@/lib/plan/schema";
import { db } from "@/lib/db";

/**
 * The purge action, which fails differently from a refund.
 *
 * A refund is blocked by a policy someone wrote down. A purge is blocked by the
 * shape of the data: it drags dependent rows out with it, and some of those
 * rows are legally retained. Neither fact appears in the request.
 */

const TENANT = process.env.SEED_TENANT ?? "demo";

async function main() {
  const sql = db();

  console.log("=== 0. RESET SANDBOX ===");
  const seeded = await resetTenant(TENANT, "purge demo");
  console.log(`${seeded.customers} customers, ${seeded.orders} orders`);

  const base = {
    tool: "customers.purge" as const,
    params: {
      selector: { inactiveSince: "2024-01-01" },
      strategy: "hard_delete" as const,
      excludeCustomerIds: [] as string[],
    },
  };

  // --- 1. What the operator asked for --------------------------------------
  console.log("\n=== 1. SIMULATE: delete dormant customers ===");
  const first = await simulate({
    tenantId: TENANT,
    plan: ActionPlan.parse(base),
    intent: "delete every customer who has not ordered since 2024",
  });

  console.log(`verdict=${first.verdict}  matched=${first.summary.matched}  acting=${first.summary.acting}`);
  console.log(`rows the dry run changed: ${first.proven.changeCount}`, first.proven.tableCounts);
  console.log("\ninvariants:");
  for (const i of first.invariants) {
    console.log(`  [${i.severity}] ${i.label}`);
    console.log(`     ${i.detail}`);
    if (i.evidence) console.log(`     evidence: ${JSON.stringify(i.evidence)}`);
    if (i.remedy) console.log(`     remedy: ${i.remedy.label}`);
  }

  console.log("\ndiff:");
  for (const i of first.impacts) {
    console.log(`  ${i.label.padEnd(14)} ${i.from} -> ${i.to}   ${i.delta}`);
  }

  // --- 2. Take the remedy ---------------------------------------------------
  const blocker = first.invariants.find((i) => i.severity === "block" && i.remedy);
  if (!blocker?.remedy) {
    console.log("\nNo blocking remedy offered; nothing more to demonstrate.");
    await sql.end();
    return;
  }

  console.log(`\n=== 2. TWEAK: ${blocker.remedy.label} ===`);
  const tweaked = ActionPlan.parse({
    ...base,
    params: { ...base.params, ...blocker.remedy.patch },
  });
  const second = await simulate({ tenantId: TENANT, plan: tweaked, intent: "…archive instead" });

  console.log(`verdict=${second.verdict}  acting=${second.summary.acting}`);
  console.log(`plan hash ${first.planHash.slice(0, 8)} -> ${second.planHash.slice(0, 8)}`);
  console.log(`rows the dry run changed: ${second.proven.changeCount}`, second.proven.tableCounts);

  if (second.verdict !== "ready") {
    console.log("still blocked:", second.invariants.filter((i) => i.severity === "block"));
    await sql.end();
    return;
  }

  // --- 3. Execute -----------------------------------------------------------
  console.log("\n=== 3. APPROVE + EXECUTE ===");
  const grant = await createApproval({ runId: second.runId, planHash: second.planHash });
  const exec = await execute({ runId: second.runId, token: grant.token });

  console.log(`status=${exec.status}  ${exec.totals.entities} ${exec.noun}(s)`);
  for (const s of exec.stages) {
    console.log(`  stage ${s.stage} ${s.kind.padEnd(6)} ${s.status.padEnd(11)} ${s.references.join(", ")}`);
  }
  if (exec.divergences.length) {
    console.log("divergences:");
    for (const d of exec.divergences) console.log(`  [${d.severity}] ${d.detail}`);
  }

  const archived = await sql`
    select name, archived_at is not null as archived
      from preflight.customers where tenant_id = ${TENANT}
       and (last_order_at is null or last_order_at < '2024-01-01'::timestamptz)
     order by name`;
  console.log("\ndormant customers now:");
  for (const r of archived) console.log(`  ${String(r.name).padEnd(14)} archived=${r.archived}`);

  // --- 4. Roll back ---------------------------------------------------------
  console.log("\n=== 4. ROLL BACK ===");
  const rb = await rollback(second.runId);
  console.log(`applied ${rb.receiptsApplied} receipt(s), restored ${rb.rowsRestored} row(s)`);

  const after = await sql`
    select count(*)::int as still_archived from preflight.customers
     where tenant_id = ${TENANT} and archived_at is not null`;
  console.log(`customers still archived after rollback: ${after[0].still_archived}`);

  await sql.end();
}

main().catch(async (e) => {
  console.error("\npurge script errored:", e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});
