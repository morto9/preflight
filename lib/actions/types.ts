export type Mode = "simulate" | "execute";

export type ActionCtx = {
  tenantId: string;
  runId: string;
  mode: Mode;
  stage: number;
};

/**
 * One entity the plan touches, described well enough that a human can judge it
 * without reading SQL. `before`/`after` drive the diff view.
 */
export type Impact = {
  id: string;
  label: string;
  who: string;
  amountCents?: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Set when the row matched the selector but will not be acted on. */
  skipped?: string;
};

/** An effect that lands outside our database, and therefore outside our control. */
export type ExternalEffect = {
  system: "stripe" | "email";
  kind: string;
  target: string;
  amountCents?: number;
  reversible: boolean;
  note: string;
  /** Populated only after a real execution. */
  externalId?: string;
};
