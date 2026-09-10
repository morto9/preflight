import type postgres from "postgres";
import { db, asPgFailure, type PgFailure } from "@/lib/db";

/**
 * The dry-run engine.
 *
 * A simulation is not a description of what a write would do. It IS the write,
 * executed against the real database inside a transaction that is guaranteed to
 * roll back. Every number the UI shows comes from Postgres actually doing the
 * work -- real affected rows, real cascades, real constraint violations.
 */

export type AuditRow = {
  id: string;
  tenant_id: string | null;
  table_name: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  row_pk: string | null;
  before_row: Record<string, unknown> | null;
  after_row: Record<string, unknown> | null;
  gate: string | null;
};

export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export type DryRunResult<T> = {
  ok: boolean;
  value?: T;
  failure?: PgFailure;
  /** Everything the transaction touched, including rows changed by cascade. */
  changes: AuditRow[];
};

const ROLLBACK = Symbol.for("preflight.rollback");

class ForcedRollback extends Error {
  readonly [ROLLBACK] = true;
  constructor() {
    super("preflight: forced rollback");
  }
}

function isForcedRollback(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && ROLLBACK in (e as object));
}

/**
 * Run `fn` against the real database and throw the work away.
 *
 * `fn` executes inside a SAVEPOINT so that when it hits a genuine constraint
 * violation the surrounding transaction stays usable -- which is what lets us
 * report *why* the write would have failed instead of just that it did.
 */
export async function dryRun<T>(fn: (tx: Tx) => Promise<T>): Promise<DryRunResult<T>> {
  const sql = db();
  let captured: DryRunResult<T> | null = null;

  try {
    await sql.begin(async (tx) => {
      await tx`select preflight.open_gate('simulate')`;

      let value: T | undefined;
      let failure: PgFailure | undefined;

      try {
        value = (await tx.savepoint(async (sp) => fn(sp as Tx))) as T;
      } catch (e) {
        failure = asPgFailure(e);
      }

      const changes = (await tx`select * from preflight.tx_audit()`) as unknown as AuditRow[];

      captured = { ok: !failure, value, failure, changes };

      // Nothing a dry run does is ever committed.
      throw new ForcedRollback();
    });
  } catch (e) {
    if (!isForcedRollback(e)) throw e;
  }

  if (!captured) throw new Error("preflight: dry run produced no result");
  return captured;
}

/**
 * First stage of a real execution. Burns the single-use approval token inside
 * the same transaction as the write, so a forged or replayed approval cannot
 * produce a partial effect.
 */
export async function executeFirstStage<T>(
  runId: string,
  tokenHash: string,
  planHash: string,
  fn: (tx: Tx) => Promise<T>
): Promise<{ value: T; changes: AuditRow[]; approvalId: string }> {
  const sql = db();
  return (await sql.begin(async (tx) => {
    const [row] = await tx`
      select preflight.open_gate_with_approval(
        ${runId}::uuid, ${tokenHash}, ${planHash}
      ) as approval_id`;

    const value = await fn(tx as Tx);
    const changes = (await tx`select * from preflight.tx_audit()`) as unknown as AuditRow[];

    return { value, changes, approvalId: String(row.approval_id) };
  })) as { value: T; changes: AuditRow[]; approvalId: string };
}

/**
 * Any stage after the first. Refused by Postgres if the breaker has moved the
 * run out of `executing`.
 */
export async function executeStage<T>(
  runId: string,
  approvalId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<{ value: T; changes: AuditRow[] }> {
  const sql = db();
  return (await sql.begin(async (tx) => {
    await tx`select preflight.open_gate_for_stage(${runId}::uuid, ${approvalId}::uuid)`;

    const value = await fn(tx as Tx);
    const changes = (await tx`select * from preflight.tx_audit()`) as unknown as AuditRow[];

    return { value, changes };
  })) as { value: T; changes: AuditRow[] };
}

/** Apply a compensating plan. Single-use, enforced by the receipt row. */
export async function executeRollback<T>(
  runId: string,
  receiptId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<{ value: T; changes: AuditRow[] }> {
  const sql = db();
  return (await sql.begin(async (tx) => {
    await tx`select preflight.open_gate_for_rollback(${runId}::uuid, ${receiptId}::uuid)`;

    const value = await fn(tx as Tx);

    await tx`
      update preflight.receipts
         set applied = true, applied_at = now()
       where id = ${receiptId}::uuid`;

    const changes = (await tx`select * from preflight.tx_audit()`) as unknown as AuditRow[];
    return { value, changes };
  })) as { value: T; changes: AuditRow[] };
}

/** Control-plane writes (seeding, sandbox provisioning) that are not business writes. */
export async function withGate<T>(gate: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const sql = db();
  return (await sql.begin(async (tx) => {
    await tx`select preflight.open_gate(${gate})`;
    return fn(tx as Tx);
  })) as T;
}
