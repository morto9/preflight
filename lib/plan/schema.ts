import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * An ActionPlan is the only thing the gateway knows how to simulate or execute.
 * Natural language never reaches the database -- it is compiled into one of
 * these first, and the plan is what gets hashed, shown, approved, and run.
 */

// Stripe only accepts these three refund reasons.
export const RefundReason = z.enum(["duplicate", "fraudulent", "requested_by_customer"]);

export const RefundBulkParams = z.object({
  selector: z.object({
    defectBatch: z.string().min(1).optional(),
    orderIds: z.array(z.uuid()).optional(),
    createdBefore: z.string().optional(),
    minAmountCents: z.number().int().nonnegative().optional(),
  }),
  mode: z.enum(["full", "partial"]).default("full"),
  partialPercent: z.number().min(1).max(100).optional(),
  reason: RefundReason.default("requested_by_customer"),
  /** The "tweak" lever: rows the operator deselected in the review step. */
  excludeOrderIds: z.array(z.uuid()).default([]),
  /** Policy ceiling asserted against the in-transaction post-state. */
  dailyCapCents: z.number().int().positive().default(500_00),
});

export const CustomerPurgeParams = z.object({
  selector: z.object({
    inactiveSince: z.string(),
    tier: z.enum(["standard", "pro", "enterprise"]).optional(),
  }),
  /** hard_delete is what people ask for; soft_archive is what they usually want. */
  strategy: z.enum(["hard_delete", "soft_archive"]).default("hard_delete"),
  excludeCustomerIds: z.array(z.uuid()).default([]),
});

export const NotifyBroadcastParams = z.object({
  selector: z.object({
    defectBatch: z.string().min(1).optional(),
    tier: z.enum(["standard", "pro", "enterprise"]).optional(),
    hasOrderSince: z.string().optional(),
  }),
  subject: z.string().min(1),
  body: z.string().min(1),
  respectUnsubscribe: z.boolean().default(true),
  excludeCustomerIds: z.array(z.uuid()).default([]),
});

export const ActionPlan = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("refund.bulk"), params: RefundBulkParams }),
  z.object({ tool: z.literal("customers.purge"), params: CustomerPurgeParams }),
  z.object({ tool: z.literal("notify.broadcast"), params: NotifyBroadcastParams }),
]);

export type ActionPlan = z.infer<typeof ActionPlan>;
export type ToolName = ActionPlan["tool"];

/**
 * Deterministic JSON with sorted keys, so that two structurally identical plans
 * always hash the same regardless of property order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * The identity of a plan. An approval is bound to this value, so changing any
 * parameter after approval -- including deselecting a single row -- produces a
 * different hash and silently invalidates the approval.
 */
export function planHash(plan: ActionPlan): string {
  return createHash("sha256").update(canonicalize(plan)).digest("hex");
}
