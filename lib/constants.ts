/**
 * Values shared by client and server code.
 *
 * Kept free of imports on purpose: anything the browser bundle touches must not
 * drag the Postgres or Stripe clients along with it.
 */
export const DEFECT_BATCH = "MAR-2026-A";
