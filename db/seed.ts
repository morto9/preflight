import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { provisionTenant, resetTenant } from "@/lib/sandbox";
import { stripeEnabled } from "@/lib/adapters/stripe";
import { db } from "@/lib/db";

/**
 * Seeds the shared demo tenant. Per-visitor sandboxes are provisioned by the
 * app at runtime using the same code path.
 */

const TENANT = process.env.SEED_TENANT ?? "demo";

async function main() {
  console.log(`Seeding tenant "${TENANT}"...`);
  console.log(
    stripeEnabled()
      ? "  Stripe test mode enabled -- creating real charges."
      : "  No STRIPE_SECRET_KEY -- seeding in ledger-only mode."
  );

  const result = await resetTenant(TENANT, "shared demo");
  console.log(
    `  ${result.customers} customers, ${result.orders} orders, ${result.stripeCharges} Stripe charges.`
  );

  console.log("Done.");
  await db().end();
}

main().catch(async (e) => {
  console.error("Seed failed:", e?.message ?? e);
  try {
    await db().end();
  } catch {}
  process.exit(1);
});

// Keep the unused import meaningful for consumers of this module.
export { provisionTenant };
