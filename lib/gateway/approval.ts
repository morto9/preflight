import { createHash, randomBytes } from "node:crypto";
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
