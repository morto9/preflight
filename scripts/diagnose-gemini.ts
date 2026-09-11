import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { db, asJson } from "@/lib/db";
import { predictConsequences } from "@/lib/llm/gemini";
import type { SimulationReport } from "@/lib/gateway";

/**
 * Why does production keep falling back to rule-based consequences?
 *
 * Runs the real consequence model against a real stored report several times
 * and prints whatever comes back, rather than letting consequencesFor() swallow
 * it into a silent downgrade.
 */

const RUNS = Number(process.env.N ?? 6);

async function main() {
  const sql = db();

  const [row] = await sql`
    select simulation from preflight.runs
     where simulation is not null
     order by created_at desc limit 1`;

  if (!row) {
    console.log("No stored simulation to test against. Run a simulation first.");
    await sql.end();
    return;
  }

  const report = asJson<SimulationReport>(row.simulation);
  console.log(`model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`);
  console.log(`report: ${report.summary.acting} acting, verdict=${report.verdict}\n`);

  let ok = 0;
  let failed = 0;

  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    try {
      const c = await predictConsequences(report);
      ok++;
      console.log(
        `  ${i}. OK    ${((Date.now() - t0) / 1000).toFixed(2)}s  ` +
          `conf=${c.confidence}  "${c.summary.slice(0, 60)}..."`
      );
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${i}. FAIL  ${((Date.now() - t0) / 1000).toFixed(2)}s  ${msg.slice(0, 400)}`);
    }
  }

  console.log(`\n${ok} ok, ${failed} failed out of ${RUNS}`);
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});
