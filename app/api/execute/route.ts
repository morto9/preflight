import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { execute } from "@/lib/gateway";
import { currentTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  const { runId, token } = (await req.json().catch(() => ({}))) as {
    runId?: string;
    token?: string;
  };
  if (!runId || !token) {
    return NextResponse.json({ error: "runId and token are required." }, { status: 400 });
  }

  const [run] = await db()`
    select id from preflight.runs where id = ${runId}::uuid and tenant_id = ${tenantId}`;
  if (!run) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  try {
    return NextResponse.json(await execute({ runId, token }));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 }
    );
  }
}
