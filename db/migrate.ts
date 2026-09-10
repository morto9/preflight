import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Applies db/migrations/*.sql in filename order, once each.
 * Safe to re-run: every migration is tracked in preflight.schema_migrations.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

async function main() {
  await sql.unsafe(`
    create schema if not exists preflight;
    create table if not exists preflight.schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    );
  `).simple();

  const applied = new Set(
    (await sql`select name from preflight.schema_migrations`).map((r) => String(r.name))
  );

  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const body = readFileSync(join(dir, file), "utf8");
    process.stdout.write(`  apply ${file} ... `);
    await sql.unsafe(body).simple();
    await sql`insert into preflight.schema_migrations (name) values (${file})`;
    console.log("ok");
    ran++;
  }

  console.log(ran === 0 ? "\nAlready up to date." : `\nApplied ${ran} migration(s).`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("\nMigration failed:", e.message ?? e);
  await sql.end();
  process.exit(1);
});
