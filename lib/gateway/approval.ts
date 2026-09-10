import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Approvals.
 *
 * An approval is not a boolean. It is a single-use, expiring token bound to the
 * hash of the exact plan that was simulated. Change one parameter -- deselect
 * one row -- and the hash changes, which makes the old approval unusable
 * without anyone having to remember to revoke it.
 */

export const APPROVAL_TTL_SECONDS = 300;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export type ApprovalGrant = {
  approvalId: string;
  token: string;
  expiresAt: string;
};

export async function createApproval(args: {
  runId: string;
  planHash: string;
  approvedBy?: string;
  note?: string;
  ttlSeconds?: number;
}): Promise<ApprovalGrant> {
  const sql = db();
  const { token, tokenHash } = mintToken();
  const ttl = args.ttlSeconds ?? APPROVAL_TTL_SECONDS;

  // Any earlier approval for this run is retired, so a re-simulation cannot
  // leave a usable token lying around for a superseded plan.
  await sql`
    update preflight.approvals
       set consumed_at = now(), note = coalesce(note, 'superseded by re-approval')
     where run_id = ${args.runId}::uuid and consumed_at is null`;

  const [row] = await sql`
    insert into preflight.approvals (run_id, plan_hash, token_hash, approved_by, expires_at, note)
    values (
      ${args.runId}::uuid, ${args.planHash}, ${tokenHash},
      ${args.approvedBy ?? "demo-operator"},
      now() + (${ttl} * interval '1 second'),
      ${args.note ?? null}
    )
    returning id, expires_at`;

  return {
    approvalId: String(row.id),
    token,
    expiresAt: new Date(row.expires_at as string).toISOString(),
  };
}

/**
 * A cheap pre-check so the UI can explain *why* an approval is unusable before
 * the database refuses it. The database check remains authoritative.
 */
export async function inspectApproval(
  runId: string,
  token: string
): Promise<{ usable: boolean; reason?: string; planHash?: string }> {
  const sql = db();
  const tokenHash = hashToken(token);

  const [row] = await sql`
    select plan_hash, token_hash, consumed_at, expires_at
      from preflight.approvals
     where run_id = ${runId}::uuid
     order by approved_at desc
     limit 1`;

  if (!row) return { usable: false, reason: "This run has never been approved." };

  if (!safeEqual(String(row.token_hash), tokenHash)) {
    return { usable: false, reason: "This approval token does not match this run." };
  }

  if (row.consumed_at) return { usable: false, reason: "This approval has already been used." };
  if (new Date(row.expires_at as string) < new Date())
    return { usable: false, reason: "This approval has expired." };

  return { usable: true, planHash: String(row.plan_hash) };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
