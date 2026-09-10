import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createApproval } from "@/lib/gateway/approval";
import { currentTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  const { runId, planHash } = (await req.json().catch(() => ({}))) as {
    runId?: string;
    planHash?: string;
  };
  if (!runId || !planHash) {
    return NextResponse.json({ error: "runId and planHash are required." }, { status: 400 });
  }

  const [run] = await db()`
    select id, plan_hash, status from preflight.runs
     where id = ${runId}::uuid and tenant_id = ${tenantId}`;

  if (!run) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  // Approving a plan that is not the one on screen is exactly the confusion the
  // hash exists to prevent, so it is refused here as well as in the database.
  if (String(run.plan_hash) !== planHash) {
    return NextResponse.json(
      { error: "This plan has changed since it was simulated. Re-simulate before approving." },
      { status: 409 }
    );
  }

  if (String(run.status) !== "simulated") {
    return NextResponse.json(
      { error: `This run is "${run.status}" and can no longer be approved.` },
      { status: 409 }
    );
  }

  const grant = await createApproval({ runId, planHash });
  return NextResponse.json(grant);
}
