import { ActionPlan } from "@/lib/plan/schema";
import type { SimulationReport, Consequences } from "@/lib/gateway";
import { money } from "@/lib/policy/invariants";

/**
 * Gemini.
 *
 * Two jobs, deliberately separated:
 *
 *  - the PLANNER turns a sentence into an ActionPlan. Its output is validated
 *    by Zod before it goes anywhere near the gateway, so a hallucinated plan is
 *    a parse error rather than a write.
 *
 *  - the CONSEQUENCE MODEL reasons about effects the database cannot show us.
 *    Everything it produces is labelled PREDICTED and it can never block, only
 *    warn. The blocking decisions belong to the invariants, which have evidence.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiEnabled(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function model(): string {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

async function callGemini(
  prompt: string,
  responseSchema: Record<string, unknown>,
  opts: { thinking?: boolean } = {}
): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.2,
      ...(opts.thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  };

  const res = await fetch(`${ENDPOINT}/${model()}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");

  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// PLANNER
// ---------------------------------------------------------------------------

/**
 * Gemini's schema dialect does not express discriminated unions, so the model
 * fills one flat object and we narrow it here. Zod is the real gate.
 */
const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    tool: { type: "STRING", enum: ["refund.bulk", "customers.purge", "notify.broadcast"] },
    rationale: { type: "STRING" },
    defectBatch: { type: "STRING" },
    mode: { type: "STRING", enum: ["full", "partial"] },
    partialPercent: { type: "NUMBER" },
    reason: {
      type: "STRING",
      enum: ["duplicate", "fraudulent", "requested_by_customer"],
    },
    minAmountCents: { type: "NUMBER" },
    inactiveSince: { type: "STRING" },
    strategy: { type: "STRING", enum: ["hard_delete", "soft_archive"] },
    tier: { type: "STRING", enum: ["standard", "pro", "enterprise"] },
    subject: { type: "STRING" },
    body: { type: "STRING" },
    respectUnsubscribe: { type: "BOOLEAN" },
  },
  required: ["tool", "rationale"],
} as const;

export type PlannedIntent = {
  plan: ActionPlan;
  rationale: string;
  source: "gemini";
};

export async function planFromIntent(
  intent: string,
  context: { defectBatches: string[]; today: string }
): Promise<PlannedIntent> {
  const prompt = `You convert an operations request into a structured action plan for a
system that refunds payments, deletes customer records, and sends bulk email.

Today is ${context.today}.
Known defect batch identifiers: ${context.defectBatches.join(", ") || "none"}.

Rules:
- Choose exactly one tool.
- refund.bulk: refunding orders. Use defectBatch when the request names a batch
  or an incident. Use mode "full" unless a percentage is stated.
- customers.purge: deleting or archiving customer records. inactiveSince must be
  an ISO date. Prefer strategy "hard_delete" only if the request is explicit
  about deletion; otherwise "soft_archive".
- notify.broadcast: emailing a group of customers. Write a real subject and body.
- Do not invent identifiers that were not given to you.
- rationale: one sentence explaining your reading of the request.

Request: ${JSON.stringify(intent)}`;

  const raw = (await callGemini(prompt, PLAN_SCHEMA)) as Record<string, unknown>;
  const rationale = String(raw.rationale ?? "");

  const plan = ActionPlan.parse(narrow(raw));
  return { plan, rationale, source: "gemini" };
}

/** Flat model output -> the discriminated ActionPlan shape. */
function narrow(raw: Record<string, unknown>): unknown {
  const tool = raw.tool;

  if (tool === "refund.bulk") {
    return {
      tool,
      params: {
        selector: {
          ...(raw.defectBatch ? { defectBatch: String(raw.defectBatch) } : {}),
          ...(typeof raw.minAmountCents === "number"
            ? { minAmountCents: Math.round(raw.minAmountCents) }
            : {}),
        },
        mode: raw.mode === "partial" ? "partial" : "full",
        ...(typeof raw.partialPercent === "number"
          ? { partialPercent: raw.partialPercent }
          : {}),
        reason: raw.reason ?? "requested_by_customer",
      },
    };
  }

  if (tool === "customers.purge") {
    return {
      tool,
      params: {
        selector: {
          inactiveSince: String(raw.inactiveSince ?? "2024-01-01"),
          ...(raw.tier ? { tier: raw.tier } : {}),
        },
        strategy: raw.strategy === "hard_delete" ? "hard_delete" : "soft_archive",
      },
    };
  }

  return {
    tool: "notify.broadcast",
    params: {
      selector: {
        ...(raw.defectBatch ? { defectBatch: String(raw.defectBatch) } : {}),
        ...(raw.tier ? { tier: raw.tier } : {}),
      },
      subject: String(raw.subject ?? "An update about your order"),
      body: String(raw.body ?? "We are writing to let you know about a recent issue."),
      respectUnsubscribe: raw.respectUnsubscribe !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// CONSEQUENCE MODEL
// ---------------------------------------------------------------------------

const CONSEQUENCE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    impacted: { type: "ARRAY", items: { type: "STRING" } },
    sideEffects: { type: "ARRAY", items: { type: "STRING" } },
    watchFor: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "NUMBER" },
  },
  required: ["summary", "impacted", "sideEffects", "watchFor", "confidence"],
} as const;

export async function predictConsequences(
  report: SimulationReport
): Promise<Consequences> {
  const prompt = `NOTHING HAS HAPPENED YET. This is a proposal awaiting a human decision.
The write was performed only inside a database transaction that was then rolled
back, so no money has moved, no record has changed, and no message has been
sent. Write in the conditional: what WOULD follow if an operator approved this.
Never state that anything has already been processed, refunded, deleted or sent.

The plan's current verdict is: ${report.verdict.toUpperCase()}.${
    report.verdict === "blocked"
      ? " A blocked plan cannot run as written, so describe what the operator should weigh if they revise it to pass, not the effects of an action that is currently forbidden."
      : ""
  }

A simulation has already PROVEN what happens inside the database. Do not repeat
those facts. Your job is the effects the database cannot see.

Proven database effects:
${JSON.stringify(report.proven.tableCounts)}
Rows changed: ${report.proven.changeCount}
Orders acted on: ${report.summary.acting} of ${report.summary.matched} matched
Money moving: ${money(report.summary.moneyCents)}
External effects: ${report.external.length} Stripe refund(s), irreversible
Policy results: ${report.invariants.map((i) => `${i.severity}:${i.label}`).join(", ")}

Answer concisely and concretely:
- impacted: who or what outside this database notices, e.g. named humans,
  downstream systems, finance reporting. Max 5 items.
- sideEffects: consequences not visible in the row counts above, e.g. customer
  emails triggered by the payment processor, accounting period effects,
  support load. Max 5 items.
- watchFor: what would indicate this went wrong after the fact. Max 4 items.
- confidence: 0 to 1, how sure you are this list is complete. Be honest; this is
  a prediction, not a measurement.
- summary: one sentence an operator reads before approving. Conditional voice.`;

  const raw = (await callGemini(prompt, CONSEQUENCE_SCHEMA, { thinking: true })) as {
    summary: string;
    impacted: string[];
    sideEffects: string[];
    watchFor: string[];
    confidence: number;
  };

  return {
    source: "gemini",
    confidence: clamp(raw.confidence),
    impacted: raw.impacted?.slice(0, 5) ?? [],
    sideEffects: raw.sideEffects?.slice(0, 5) ?? [],
    watchFor: raw.watchFor?.slice(0, 4) ?? [],
    summary: raw.summary ?? "",
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Used when there is no API key, or when Gemini fails. Deliberately modest:
 * it states only what can be derived without a model.
 */
export function ruleBasedConsequences(report: SimulationReport): Consequences {
  const impacted: string[] = [];
  const sideEffects: string[] = [];

  const people = new Set(report.impacts.filter((i) => !i.skipped).map((i) => i.who));
  if (people.size) impacted.push(`${people.size} customer(s) whose payment state changes`);
  if (report.external.length) {
    impacted.push("Stripe, which holds the authoritative record of these payments");
    sideEffects.push(
      `${report.external.length} refund email(s) sent by Stripe directly to customers`
    );
  }
  for (const u of report.proven.unnamedEffects) {
    sideEffects.push(`${u.rows} row(s) written to preflight.${u.table}, which the plan never named`);
  }

  return {
    source: "rules",
    confidence: 0.4,
    impacted,
    sideEffects,
    watchFor: [
      "Stripe balance not matching the local ledger",
      "Customers contacting support about unexpected refunds",
    ],
    summary: `${report.summary.acting} order(s) change, moving ${money(report.summary.moneyCents)}.`,
  };
}

/** Never let the consequence model break a simulation. */
export async function consequencesFor(report: SimulationReport): Promise<Consequences> {
  if (!geminiEnabled()) return ruleBasedConsequences(report);
  try {
    return await predictConsequences(report);
  } catch {
    return ruleBasedConsequences(report);
  }
}
