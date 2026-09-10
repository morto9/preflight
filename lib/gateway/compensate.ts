import type { AuditRow, Tx } from "@/lib/adapters/postgres";

/**
 * The rollback path.
 *
 * Compensation is not written by hand per action, and it is not inferred after
 * the fact. It is derived mechanically from the pre-images the audit log
 * captured while the write was happening:
 *
 *   INSERT -> delete that row
 *   UPDATE -> restore the exact prior row
 *   DELETE -> reinsert the exact prior row
 *
 * Applied in reverse order, this returns the database to its precise earlier
 * state, including rows that were only touched by cascade.
 */

const REVERSIBLE_TABLES = new Set([
  "customers",
  "orders",
  "refunds",
  "ledger_entries",
  "notifications",
  "invoices",
]);

export type CompensationStep =
  | { op: "delete"; table: string; pk: string }
  | { op: "restore"; table: string; pk: string; row: Record<string, unknown> }
  | { op: "reinsert"; table: string; row: Record<string, unknown> };

export function buildCompensation(changes: AuditRow[]): CompensationStep[] {
  const steps: CompensationStep[] = [];

  // Reverse order so dependents are undone before the rows they depend on.
  for (const c of [...changes].reverse()) {
    if (!REVERSIBLE_TABLES.has(c.table_name)) continue;

    if (c.op === "INSERT" && c.row_pk) {
      steps.push({ op: "delete", table: c.table_name, pk: c.row_pk });
    } else if (c.op === "UPDATE" && c.row_pk && c.before_row) {
      steps.push({ op: "restore", table: c.table_name, pk: c.row_pk, row: c.before_row });
    } else if (c.op === "DELETE" && c.before_row) {
      steps.push({ op: "reinsert", table: c.table_name, row: c.before_row });
    }
  }

  return steps;
}

/** Human-readable summary of what a rollback would do, shown before approval. */
export function describeCompensation(steps: CompensationStep[]): {
  total: number;
  byTable: Record<string, { restore: number; delete: number; reinsert: number }>;
} {
  const byTable: Record<string, { restore: number; delete: number; reinsert: number }> = {};

  for (const s of steps) {
    byTable[s.table] ??= { restore: 0, delete: 0, reinsert: 0 };
    if (s.op === "delete") byTable[s.table].delete++;
    else if (s.op === "restore") byTable[s.table].restore++;
    else byTable[s.table].reinsert++;
  }

  return { total: steps.length, byTable };
}

export async function applyCompensation(tx: Tx, steps: CompensationStep[]): Promise<number> {
  let applied = 0;

  for (const step of steps) {
    // Table names come from our own audit log, but they interpolate as
    // identifiers, so they are allowlisted regardless.
    if (!REVERSIBLE_TABLES.has(step.table)) {
      throw new Error(`preflight: refusing to compensate unknown table "${step.table}"`);
    }

    if (step.op === "delete") {
      await tx`delete from preflight.${tx(step.table)} where id = ${step.pk}`;
    } else if (step.op === "restore") {
      const row = stripGenerated(step.row);
      await tx`update preflight.${tx(step.table)} set ${tx(row)} where id = ${step.pk}`;
    } else {
      await tx`insert into preflight.${tx(step.table)} ${tx(step.row as never)}`;
    }
    applied++;
  }

  return applied;
}

/** `id` is the match key, not something to reassign. */
function stripGenerated(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = row;
  return rest;
}
