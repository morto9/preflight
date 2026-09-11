import { DEFECT_BATCH } from "@/lib/constants";

/**
 * One-click intents.
 *
 * These exist so a reviewer can walk the whole cycle without typing, and so the
 * demo never depends on a model call. Typed intents go through Gemini; these do
 * not touch it at all.
 */
export const PRESETS = [
  {
    id: "refund-batch",
    label: "Refund the March defect batch",
    intent: `Refund every order hit by the ${DEFECT_BATCH} defect batch`,
    hint: "Exceeds the daily refund ceiling. The simulation blocks it and offers a fix.",
    plan: {
      tool: "refund.bulk" as const,
      params: {
        selector: { defectBatch: DEFECT_BATCH },
        mode: "full" as const,
        reason: "requested_by_customer" as const,
        excludeOrderIds: [] as string[],
        dailyCapCents: 200_000,
      },
    },
  },
  {
    id: "refund-large",
    label: "Refund only the large orders",
    intent: `Refund orders over $200 in the ${DEFECT_BATCH} batch`,
    hint: "A smaller, permitted plan. Passes policy and executes.",
    plan: {
      tool: "refund.bulk" as const,
      params: {
        selector: { defectBatch: DEFECT_BATCH, minAmountCents: 20_000 },
        mode: "full" as const,
        reason: "requested_by_customer" as const,
        excludeOrderIds: [] as string[],
        dailyCapCents: 200_000,
      },
    },
  },
  {
    id: "refund-half",
    label: "Refund 50% as goodwill",
    intent: `Give everyone in the ${DEFECT_BATCH} batch a 50% goodwill refund`,
    hint: "Partial refunds against charges that are already partly refunded.",
    plan: {
      tool: "refund.bulk" as const,
      params: {
        selector: { defectBatch: DEFECT_BATCH },
        mode: "partial" as const,
        partialPercent: 50,
        reason: "requested_by_customer" as const,
        excludeOrderIds: [] as string[],
        dailyCapCents: 200_000,
      },
    },
  },
  {
    id: "purge-dormant",
    label: "Delete dormant customers",
    intent: "Delete every customer who has not ordered since 2024",
    hint: "The delete drags dependent rows out with it, and Postgres refuses it outright.",
    plan: {
      tool: "customers.purge" as const,
      params: {
        selector: { inactiveSince: "2024-01-01" },
        strategy: "hard_delete" as const,
        excludeCustomerIds: [] as string[],
      },
    },
  },
] as const;

export type Preset = (typeof PRESETS)[number];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
