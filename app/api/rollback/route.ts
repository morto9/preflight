import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rollback } from "@/lib/gateway";
import { currentTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  const { runId } = (await req.json().catch(() => ({}))) as { runId?: string };
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });

  const [run] = await db()`
    select id from preflight.runs where id = ${runId}::uuid and tenant_id = ${tenantId}`;
  if (!run) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  try {
    return NextResponse.json(await rollback(runId));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 }
    );
  }
}
