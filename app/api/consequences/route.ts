import { NextResponse } from "next/server";
import { db, asJson, jsonb } from "@/lib/db";
import { consequencesFor } from "@/lib/llm/gemini";
import { currentTenant } from "@/lib/session";
import type { SimulationReport } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * The predicted half of a simulation, fetched separately.
 *
 * Everything the gateway can prove is fast; the model is not. Splitting them
 * means the evidence reaches the operator in about a second instead of waiting
 * on an opinion — which is also the honest ordering, since the prediction is
 * advisory and can never block.
 */
export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });

  const sql = db();
  const [run] = await sql`
    select simulation from preflight.runs
     where id = ${runId}::uuid and tenant_id = ${tenantId}`;

  if (!run?.simulation) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  const report = asJson<SimulationReport>(run.simulation);
  const consequences = await consequencesFor(report);

  // Persist onto the stored report so reloading a run does not re-ask the model.
  // The whole document is rewritten rather than patched in place, which also
  // repairs rows written before jsonb values were stored as real objects.
  await sql`
    update preflight.runs
       set simulation = ${jsonb({ ...report, consequences })}, updated_at = now()
     where id = ${runId}::uuid`;

  return NextResponse.json(consequences);
}
