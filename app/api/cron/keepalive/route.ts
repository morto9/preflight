import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Free Supabase projects pause after about a week of inactivity, which would
 * quietly kill the live demo. A daily query keeps it awake, and old sandboxes
 * get cleaned up while we are here.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");

  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sql = db();
  const [alive] = await sql`select now() as at`;

  // Sandboxes nobody has touched in two days are dead weight. Deleting the
  // tenant cascades through the business tables, so the gate must be open.
  const [{ count }] = await sql`
    select count(*)::int as count from preflight.tenants
     where last_seen_at < now() - interval '2 days' and id <> 'demo'`;

  if (count > 0) {
    await sql.begin(async (tx) => {
      await tx`select preflight.open_gate('cleanup')`;
      await tx`
        delete from preflight.tenants
         where last_seen_at < now() - interval '2 days' and id <> 'demo'`;
    });
  }

  return NextResponse.json({ ok: true, at: alive.at, sandboxesReaped: count });
}
