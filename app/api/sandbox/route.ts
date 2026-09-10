import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { provisionTenant, resetTenant } from "@/lib/sandbox";
import { COOKIE_NAME, COOKIE_OPTIONS, cookieValue, currentTenant, newTenantId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provision this visitor's sandbox, or reset it.
 *
 * Provisioning creates real Stripe test charges, so it takes a few seconds.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { reset?: boolean };
  const existing = await currentTenant();

  try {
    if (existing && body.reset) {
      const result = await resetTenant(existing);
      return NextResponse.json({ ...result, reset: true });
    }

    if (existing) {
      return NextResponse.json({ tenantId: existing, reused: true });
    }

    const tenantId = newTenantId();
    const result = await provisionTenant(tenantId, "live demo sandbox");

    const jar = await cookies();
    jar.set(COOKIE_NAME, cookieValue(tenantId), COOKIE_OPTIONS);

    return NextResponse.json({ ...result, created: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
