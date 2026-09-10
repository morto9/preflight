import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

/**
 * Sandbox identity.
 *
 * Every visitor gets their own tenant so that two people opening the demo at
 * once never see each other's refunds. The cookie is signed so a visitor cannot
 * hand themselves someone else's sandbox by editing it.
 */

const COOKIE = "preflight_sandbox";
const MAX_AGE = 60 * 60 * 24 * 7;

function secret(): string {
  return process.env.SESSION_SECRET || "preflight-development-secret";
}

function sign(id: string): string {
  return createHmac("sha256", secret()).update(id).digest("base64url");
}

function verify(value: string): string | null {
  const [id, sig] = value.split(".");
  if (!id || !sig) return null;

  const expected = sign(id);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return id;
}

export function newTenantId(): string {
  return `t_${randomBytes(9).toString("hex")}`;
}

export function cookieValue(tenantId: string): string {
  return `${tenantId}.${sign(tenantId)}`;
}

export const COOKIE_NAME = COOKIE;
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE,
};

/** The current sandbox, or null if this visitor has not been given one yet. */
export async function currentTenant(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;

  const id = verify(raw);
  if (!id) return null;

  const rows = await db()`select id from preflight.tenants where id = ${id}`;
  return rows.length ? id : null;
}

/** Bounded model usage per sandbox per day. */
export async function claimAiCall(tenantId: string, cap = 30): Promise<boolean> {
  const [row] = await db()`select preflight.claim_ai_call(${tenantId}, ${cap}) as allowed`;
  return Boolean(row.allowed);
}

export async function touchTenant(tenantId: string): Promise<void> {
  await db()`update preflight.tenants set last_seen_at = now() where id = ${tenantId}`;
}
