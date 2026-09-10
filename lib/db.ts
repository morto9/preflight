import postgres from "postgres";

/**
 * Postgres connection.
 *
 * This MUST go through Supabase's Supavisor pooler, not a direct connection:
 * Vercel's runtime has no IPv6, and Supabase free-tier direct connections are
 * IPv6-only. The transaction pooler (port 6543) also forbids prepared
 * statements, hence `prepare: false`.
 *
 * The pooler pins a backend for the duration of a transaction, so the explicit
 * BEGIN/SAVEPOINT/ROLLBACK the dry-run engine depends on works correctly.
 */
let _sql: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the " +
        "Supabase connection string (Session or Transaction pooler, not the direct URL)."
    );
  }

  _sql = postgres(url, {
    prepare: false, // required by the Supavisor transaction pooler
    max: 1, // one connection per serverless invocation
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });

  return _sql;
}

/** Postgres error shape we care about when a simulation hits a real constraint. */
export type PgFailure = {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  table?: string;
  constraint?: string;
};

export function asPgFailure(e: unknown): PgFailure {
  const err = e as Record<string, unknown>;
  return {
    code: String(err?.code ?? "UNKNOWN"),
    message: String(err?.message ?? e),
    detail: err?.detail ? String(err.detail) : undefined,
    hint: err?.hint ? String(err.hint) : undefined,
    table: err?.table_name ? String(err.table_name) : undefined,
    constraint: err?.constraint_name ? String(err.constraint_name) : undefined,
  };
}

/** True when Postgres refused a write because the gate was closed. */
export function isGateRefusal(e: PgFailure): boolean {
  return e.code === "P0001" && e.message.includes("PREFLIGHT:");
}

/**
 * postgres.js can hand back jsonb as a raw string when running unprepared
 * through the transaction pooler, so every jsonb read goes through this.
 */
export function asJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
