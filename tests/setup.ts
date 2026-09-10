import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

/**
 * The suite runs against a real Postgres database, because the thing being
 * tested is precisely that the database refuses writes and that a transaction
 * really does roll back. A fake would prove nothing here.
 *
 * Stripe is switched off for the suite: these tests are about the gate, and
 * creating dozens of real charges would make them slow without making them
 * stronger. The Stripe path has its own script, scripts/failure-test.ts.
 */
delete process.env.STRIPE_SECRET_KEY;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run the test suite.");
}
