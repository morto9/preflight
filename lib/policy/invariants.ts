/**
 * The policy engine.
 *
 * Invariants are asserted against the post-state of the dry run -- the state
 * the database actually reached before rolling back -- so a `block` here is a
 * statement about what would really have happened, not a guess.
 *
 * Every blocking invariant carries a `remedy`: a concrete patch to the plan
 * that would resolve it. That is what makes "tweak" a single click rather than
 * an invitation to go and rewrite the request.
 */

export type Severity = "pass" | "warn" | "block";

export type Remedy = {
  label: string;
  /** A shallow patch merged into plan.params. */
  patch: Record<string, unknown>;
};

export type InvariantResult = {
  id: string;
  label: string;
  severity: Severity;
  detail: string;
  evidence?: Record<string, unknown>;
  remedy?: Remedy;
};

export function worstSeverity(results: InvariantResult[]): Severity {
  if (results.some((r) => r.severity === "block")) return "block";
  if (results.some((r) => r.severity === "warn")) return "warn";
  return "pass";
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ---------------------------------------------------------------------------
// refund.bulk
// ---------------------------------------------------------------------------

export type RefundInvariantInput = {
  targets: {
    orderId: string;
    reference: string;
    refundCents: number;
    amountCents: number;
    alreadyRefundedCents: number;
    chargeId: string | null;
    driftCents: number;
    customerName: string;
    /** Deselected by the operator, as opposed to having nothing left to refund. */
    excluded: boolean;
  }[];
  dailyCapCents: number;
  /** Refunds already issued today, outside this plan. */
  spentTodayCents: number;
};

export function refundInvariants(input: RefundInvariantInput): InvariantResult[] {
  const { targets, dailyCapCents, spentTodayCents } = input;
  const results: InvariantResult[] = [];
  const active = targets.filter((t) => t.refundCents > 0);
  const planTotal = active.reduce((s, t) => s + t.refundCents, 0);

  // --- 1. No refund may exceed what is still refundable on the charge -------
  const overRefunds = targets.filter(
    (t) => t.refundCents > t.amountCents - t.alreadyRefundedCents
  );
  results.push(
    overRefunds.length === 0
      ? {
          id: "refund_within_captured",
          label: "Refund never exceeds captured amount",
          severity: "pass",
          detail: `All ${active.length} refunds are within the remaining refundable balance.`,
        }
      : {
          id: "refund_within_captured",
          label: "Refund never exceeds captured amount",
          severity: "block",
          detail: `${overRefunds.length} order(s) would be refunded beyond their remaining balance.`,
          evidence: {
            orders: overRefunds.map((t) => ({
              reference: t.reference,
              attempted: money(t.refundCents),
              refundable: money(t.amountCents - t.alreadyRefundedCents),
            })),
          },
          remedy: {
            label: "Exclude the over-refunding orders",
            patch: { excludeOrderIds: overRefunds.map((t) => t.orderId) },
          },
        }
  );

  // --- 2. Daily refund ceiling ---------------------------------------------
  const projected = planTotal + spentTodayCents;
  if (projected > dailyCapCents) {
    // Choose the smallest set of largest refunds that brings the plan under.
    const sorted = [...active].sort((a, b) => b.refundCents - a.refundCents);
    const drop: typeof sorted = [];
    let running = projected;
    for (const t of sorted) {
      if (running <= dailyCapCents) break;
      drop.push(t);
      running -= t.refundCents;
    }

    results.push({
      id: "daily_refund_cap",
      label: "Daily refund ceiling",
      severity: "block",
      detail:
        `This plan would refund ${money(planTotal)}. With ${money(spentTodayCents)} ` +
        `already refunded today that reaches ${money(projected)}, which is ` +
        `${money(projected - dailyCapCents)} over the ${money(dailyCapCents)} ceiling.`,
      evidence: {
        planTotal: money(planTotal),
        spentToday: money(spentTodayCents),
        cap: money(dailyCapCents),
        over: money(projected - dailyCapCents),
      },
      remedy: {
        label: `Exclude the ${drop.length} largest refund(s) (${money(
          drop.reduce((s, t) => s + t.refundCents, 0)
        )})`,
        patch: { excludeOrderIds: drop.map((t) => t.orderId) },
      },
    });
  } else {
    results.push({
      id: "daily_refund_cap",
      label: "Daily refund ceiling",
      severity: "pass",
      detail: `${money(projected)} of the ${money(dailyCapCents)} daily ceiling, leaving ${money(
        dailyCapCents - projected
      )}.`,
      evidence: { planTotal: money(planTotal), cap: money(dailyCapCents) },
    });
  }

  // --- 3. Our cached mirror disagrees with Stripe ---------------------------
  const drifted = targets.filter((t) => t.driftCents !== 0);
  if (drifted.length > 0) {
    results.push({
      id: "mirror_drift",
      label: "Local refund mirror matches Stripe",
      severity: "block",
      detail:
        `${drifted.length} order(s) hold a refunded amount locally that disagrees with Stripe. ` +
        `Stripe is the source of truth, so the forecast for these orders is unreliable.`,
      evidence: {
        orders: drifted.map((t) => ({
          reference: t.reference,
          local: money(t.alreadyRefundedCents - t.driftCents),
          stripe: money(t.alreadyRefundedCents),
          drift: money(t.driftCents),
        })),
      },
      remedy: {
        label: "Exclude the drifted orders and refund the rest",
        patch: { excludeOrderIds: drifted.map((t) => t.orderId) },
      },
    });
  } else {
    results.push({
      id: "mirror_drift",
      label: "Local refund mirror matches Stripe",
      severity: "pass",
      detail: `All ${targets.length} charge(s) reconcile exactly against Stripe.`,
    });
  }

  // --- 4. Orders with nothing left to refund -------------------------------
  // Deselected orders also have a zero refund, but that is a decision rather
  // than a discovery, so the two are reported separately.
  const empty = targets.filter((t) => !t.excluded && t.refundCents <= 0);
  if (empty.length > 0) {
    results.push({
      id: "fully_refunded_orders",
      label: "Orders with nothing left to refund",
      severity: "warn",
      detail: `${empty.length} selected order(s) are already fully refunded and will be skipped.`,
      evidence: { orders: empty.map((t) => t.reference) },
    });
  }

  const deselected = targets.filter((t) => t.excluded);
  if (deselected.length > 0) {
    results.push({
      id: "deselected_orders",
      label: "Orders you deselected",
      severity: "pass",
      detail: `${deselected.length} order(s) were removed from this plan by hand and will not be touched.`,
      evidence: { orders: deselected.map((t) => t.reference) },
    });
  }

  // --- 5. Orders with no Stripe charge behind them --------------------------
  const unbacked = active.filter((t) => !t.chargeId);
  if (unbacked.length > 0) {
    results.push({
      id: "ledger_only_orders",
      label: "Orders backed by a real payment",
      severity: "warn",
      detail:
        `${unbacked.length} order(s) have no Stripe charge, so their refund is recorded in ` +
        `the ledger only. No external money movement will occur for them.`,
      evidence: { orders: unbacked.map((t) => t.reference) },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// customers.purge
// ---------------------------------------------------------------------------

export type PurgeInvariantInput = {
  strategy: "hard_delete" | "soft_archive";
  customerCount: number;
  cascadeCounts: Record<string, number>;
  blockedByInvoice: { customerId: string; name: string; invoices: number }[];
};

export function purgeInvariants(input: PurgeInvariantInput): InvariantResult[] {
  const results: InvariantResult[] = [];
  const cascadeTotal = Object.values(input.cascadeCounts).reduce((a, b) => a + b, 0);

  if (input.blockedByInvoice.length > 0 && input.strategy === "hard_delete") {
    results.push({
      id: "retained_invoices",
      label: "Customers with retained invoices",
      severity: "block",
      detail:
        `${input.blockedByInvoice.length} customer(s) have invoices that must be retained. ` +
        `Postgres refuses the delete outright.`,
      evidence: { customers: input.blockedByInvoice },
      remedy: {
        label: "Archive instead of deleting",
        patch: { strategy: "soft_archive" },
      },
    });
  }

  if (input.strategy === "hard_delete" && cascadeTotal > 0) {
    results.push({
      id: "cascade_blast_radius",
      label: "Records removed by cascade",
      severity: "warn",
      detail:
        `Deleting ${input.customerCount} customer(s) also removes ${cascadeTotal} dependent ` +
        `record(s) that were never named in the request.`,
      evidence: input.cascadeCounts,
      remedy: {
        label: "Archive instead of deleting",
        patch: { strategy: "soft_archive" },
      },
    });
  }

  if (input.strategy === "soft_archive") {
    results.push({
      id: "reversible_strategy",
      label: "Strategy is reversible",
      severity: "pass",
      detail: "Archiving sets a flag and can be undone completely.",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// notify.broadcast
// ---------------------------------------------------------------------------

export type BroadcastInvariantInput = {
  recipientCount: number;
  unsubscribed: { customerId: string; name: string; email: string }[];
  respectUnsubscribe: boolean;
};

export function broadcastInvariants(input: BroadcastInvariantInput): InvariantResult[] {
  const results: InvariantResult[] = [];

  if (input.unsubscribed.length > 0 && !input.respectUnsubscribe) {
    results.push({
      id: "respect_unsubscribe",
      label: "Unsubscribed recipients",
      severity: "block",
      detail: `${input.unsubscribed.length} recipient(s) have unsubscribed and must not be contacted.`,
      evidence: { customers: input.unsubscribed },
      remedy: { label: "Skip unsubscribed recipients", patch: { respectUnsubscribe: true } },
    });
  } else if (input.unsubscribed.length > 0) {
    results.push({
      id: "respect_unsubscribe",
      label: "Unsubscribed recipients",
      severity: "pass",
      detail: `${input.unsubscribed.length} unsubscribed recipient(s) excluded from the send.`,
      evidence: { customers: input.unsubscribed.map((u) => u.email) },
    });
  }

  results.push({
    id: "send_is_irreversible",
    label: "Sending cannot be undone",
    severity: input.recipientCount > 0 ? "warn" : "pass",
    detail:
      input.recipientCount > 0
        ? `${input.recipientCount} message(s) would leave the system. Rollback can only retract the queue, not recall delivered mail.`
        : "No recipients match this plan.",
  });

  return results;
}
