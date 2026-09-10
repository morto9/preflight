import Stripe from "stripe";

/**
 * Stripe adapter.
 *
 * Stripe is the source of truth for refund state. Our `orders.amount_refunded_cents`
 * column is only a cached mirror of it, and the difference between the two is the
 * entire subject of the failure test.
 */

let _stripe: Stripe | null = null;

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripe(): Stripe {
  if (_stripe) return _stripe;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  // This application issues refunds. It must never be pointed at a live account,
  // and that is worth enforcing rather than documenting.
  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "Refusing to start: STRIPE_SECRET_KEY is not a test key. " +
        "Preflight moves money and is only ever run against Stripe test mode."
    );
  }

  _stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 });
  return _stripe;
}

/** What Stripe says is true about a charge, right now. */
export type ChargeTruth = {
  chargeId: string;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  refunded: boolean;
  status: string;
  /** Set when the charge could not be read at all. */
  error?: string;
};

export type CreatedCharge = { paymentIntentId: string; chargeId: string };

/**
 * Creates a real, succeeded, refundable charge in test mode using Stripe's
 * built-in test payment method.
 */
export async function createTestCharge(
  amountCents: number,
  currency = "usd"
): Promise<CreatedCharge> {
  const pi = await stripe().paymentIntents.create({
    amount: amountCents,
    currency,
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    description: "Preflight demo order",
  });

  const chargeId =
    typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;

  if (!chargeId) throw new Error(`Stripe did not return a charge for ${pi.id}`);
  return { paymentIntentId: pi.id, chargeId };
}

/** Read one charge's true state. */
export async function readChargeTruth(chargeId: string): Promise<ChargeTruth> {
  try {
    const c = await stripe().charges.retrieve(chargeId);
    return {
      chargeId,
      amountCents: c.amount,
      amountRefundedCents: c.amount_refunded,
      currency: c.currency,
      refunded: c.refunded,
      status: c.status,
    };
  } catch (e) {
    return {
      chargeId,
      amountCents: 0,
      amountRefundedCents: 0,
      currency: "usd",
      refunded: false,
      status: "unreadable",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Read many charges with bounded concurrency. */
export async function readChargeTruths(
  chargeIds: string[],
  concurrency = 16
): Promise<Map<string, ChargeTruth>> {
  const out = new Map<string, ChargeTruth>();
  const queue = [...chargeIds];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      out.set(id, await readChargeTruth(id));
    }
  });

  await Promise.all(workers);
  return out;
}

export type RefundOutcome =
  | { ok: true; refundId: string; amountCents: number }
  | { ok: false; error: string; code?: string };

/**
 * Issue a real refund.
 *
 * The idempotency key is derived from (run, order), so a retry, a double-click,
 * or a resumed stage can never produce a second refund.
 */
export async function refundCharge(args: {
  chargeId: string;
  amountCents: number;
  reason: "duplicate" | "fraudulent" | "requested_by_customer";
  idempotencyKey: string;
}): Promise<RefundOutcome> {
  try {
    const refund = await stripe().refunds.create(
      {
        charge: args.chargeId,
        amount: args.amountCents,
        reason: args.reason,
      },
      { idempotencyKey: args.idempotencyKey }
    );
    return { ok: true, refundId: refund.id, amountCents: refund.amount };
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    return { ok: false, error: err.message ?? String(e), code: err.code };
  }
}

/**
 * Used only by the failure-test injector: issues an out-of-band refund exactly
 * the way a human clicking around the Stripe dashboard would, leaving our
 * cached mirror stale.
 */
export async function refundOutOfBand(
  chargeId: string,
  amountCents: number
): Promise<RefundOutcome> {
  try {
    const refund = await stripe().refunds.create({
      charge: chargeId,
      amount: amountCents,
      reason: "requested_by_customer",
    });
    return { ok: true, refundId: refund.id, amountCents: refund.amount };
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    return { ok: false, error: err.message ?? String(e), code: err.code };
  }
}
