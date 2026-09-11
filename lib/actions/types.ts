export type Mode = "simulate" | "execute";

export type ActionCtx = {
  tenantId: string;
  runId: string;
  mode: Mode;
  stage: number;
};

/**
 * One entity the plan touches, described well enough that a human can judge it
 * without reading SQL.
 *
 * `from`/`to`/`delta` are what the diff table renders, so they are plain strings
 * chosen by each action rather than a shape the UI has to know about. `before`
 * and `after` carry the fuller row state behind them.
 */
export type Impact = {
  id: string;
  label: string;
  who: string;
  /** Rendered in the diff table's before → after columns. */
  from: string;
  to: string;
  /** The right-hand column: the magnitude or nature of the change. */
  delta: string;
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
