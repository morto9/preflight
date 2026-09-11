import { createHash } from "node:crypto";
import { ActionPlan, canonicalize } from "@/lib/plan/schema";
import { db, jsonb, asJson } from "@/lib/db";
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

/**
 * Models to try, in order.
 *
 * The free tier meters requests per DAY per MODEL for the whole project -- 20
 * for gemini-2.5-flash -- so exhausting one model does not exhaust the others.
 * Walking a chain multiplies the usable allowance without changing behaviour.
 */
function modelChain(): string[] {
  const primary = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const rest = (
    process.env.GEMINI_MODEL_FALLBACKS ||
    "gemini-2.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash"
  ).split(",");

  return [...new Set([primary, ...rest].map((m) => m.trim()).filter(Boolean))];
}

export type Exhaustion = { model: string; detail: string };

export class QuotaExhausted extends Error {
  constructor(public readonly exhausted: Exhaustion[]) {
    super(
      "Every configured model returned 429: " +
        exhausted.map((e) => `${e.model} (${e.detail})`).join("; ")
    );
  }

  /**
   * Why it ran out, because the remedies are not the same. A depleted prepaid
   * balance is a billing action; a daily cap is a wait; a rate limit is a
   * retry. Saying "quota" for all three is how a billing problem gets mistaken
   * for a busy afternoon.
   */
  get reason(): "credits" | "daily-quota" | "rate" {
    const text = this.exhausted.map((e) => e.detail).join(" ").toLowerCase();
    if (/prepay|billing|credits?/.test(text)) return "credits";
    if (text.includes("perday")) return "daily-quota";
    return "rate";
  }
}

/** The most specific thing the 429 body will tell us. */
function quotaDetail(body: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; details?: { violations?: { quotaId?: string; quotaValue?: string }[] }[] };
    };
    const v = j.error?.details?.find((d) => d?.violations)?.violations?.[0];
    if (v?.quotaId) return `${v.quotaId} limit=${v.quotaValue ?? "?"}`;
    if (j.error?.message) return flat(j.error.message).slice(0, 180);
  } catch {}
  return flat(body).slice(0, 180) || "429 with no detail";
}

async function callGemini(
  prompt: string,
  responseSchema: Record<string, unknown>,
  opts: { thinking?: boolean } = {}
): Promise<{ data: unknown; model: string }> {
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

  const chain = modelChain();
  const exhausted: Exhaustion[] = [];
  let lastError = "";

  for (const model of chain) {
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastError = `${model}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }

    // Quota is per model, so this one being spent says nothing about the next.
    // Keep the body: it is the difference between "wait until tomorrow" and
    // "the account has no credit".
    if (res.status === 429) {
      exhausted.push({ model, detail: quotaDetail(await res.text().catch(() => "")) });
      continue;
    }

    if (!res.ok) {
      lastError = `${model}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
      continue;
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastError = `${model}: returned no content`;
      continue;
    }

    return { data: JSON.parse(text), model };
  }

  if (exhausted.length === chain.length) throw new QuotaExhausted(exhausted);
  throw new Error(`Gemini unavailable -- ${lastError}`);
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

  const { data } = await callGemini(prompt, PLAN_SCHEMA);
  const raw = data as Record<string, unknown>;
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

  const { data, model } = await callGemini(prompt, CONSEQUENCE_SCHEMA, { thinking: true });
  const raw = data as {
    summary: string;
    impacted: string[];
    sideEffects: string[];
    watchFor: string[];
    confidence: number;
  };

  return {
    source: "gemini",
    model,
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
  const watchFor: string[] = [];
  const money_ = report.tool === "refund.bulk";

  const people = new Set(report.impacts.filter((i) => !i.skipped).map((i) => i.who));
  if (people.size) {
    impacted.push(
      money_
        ? `${people.size} customer(s) whose payment state changes`
        : `${people.size} customer(s) whose records are removed`
    );
  }

  if (report.external.length) {
    impacted.push("Stripe, which holds the authoritative record of these payments");
    sideEffects.push(
      `${report.external.length} refund email(s) sent by Stripe directly to customers`
    );
    watchFor.push("Stripe balance not matching the local ledger");
  }

  // The rows nobody asked for. On a purge this is the whole story, so it leads.
  for (const u of report.proven.unnamedEffects) {
    sideEffects.push(`${u.rows} row(s) written to preflight.${u.table}, which the plan never named`);
  }

  watchFor.push(
    money_
      ? "Customers contacting support about unexpected refunds"
      : "Support or finance referencing customer records that no longer resolve"
  );

  return {
    source: "rules",
    confidence: 0.4,
    impacted,
    sideEffects,
    watchFor,
    summary: money_
      ? `${report.summary.acting} order(s) change, moving ${money(report.summary.moneyCents)}.`
      : purgeSummary(report),
  };
}

/**
 * The facts the prompt actually uses.
 *
 * Deliberately aggregate: no order ids, no sandbox id. Two visitors running the
 * same preset reach identical facts, so they share one answer instead of
 * spending two of the day's twenty requests asking the same question.
 */
function consequenceFacts(report: SimulationReport) {
  return {
    tool: report.tool,
    verdict: report.verdict,
    acting: report.summary.acting,
    matched: report.summary.matched,
    moneyCents: report.summary.moneyCents,
    changeCount: report.proven.changeCount,
    tableCounts: report.proven.tableCounts,
    externalCount: report.external.length,
    invariants: report.invariants.map((i) => `${i.severity}:${i.label}`).sort(),
  };
}

function cacheKey(report: SimulationReport): string {
  return createHash("sha256").update(canonicalize(consequenceFacts(report))).digest("hex");
}

async function readCache(key: string): Promise<Consequences | null> {
  try {
    const [row] = await db()`
      update preflight.consequence_cache
         set hits = hits + 1
       where key = ${key}
      returning consequences`;
    return row ? asJson<Consequences>(row.consequences) : null;
  } catch {
    // A missing cache table must never cost us the prediction.
    return null;
  }
}

async function writeCache(key: string, consequences: Consequences): Promise<void> {
  try {
    await db()`
      insert into preflight.consequence_cache (key, model, consequences)
      values (${key}, ${consequences.model ?? null}, ${jsonb(consequences)})
      on conflict (key) do nothing`;
  } catch {
    // Failing to cache is not worth failing the request over.
  }
}

/**
 * Never let the consequence model break a simulation.
 *
 * Failures are logged and, when they happen, said out loud in the returned
 * value: a fallback that hides why it fired looks identical to a genuinely
 * thin answer, which is how a quota problem went unnoticed for a day.
 */
export async function consequencesFor(report: SimulationReport): Promise<Consequences> {
  if (!geminiEnabled()) {
    return {
      ...ruleBasedConsequences(report),
      degraded: "No model is configured, so this is a rules-based summary.",
    };
  }

  const key = cacheKey(report);
  const hit = await readCache(key);
  if (hit) return { ...hit, cached: true };

  try {
    const fresh = await predictConsequences(report);
    await writeCache(key, fresh);
    return fresh;
  } catch (e) {
    console.error(
      "[preflight] consequence model failed, falling back to rules:",
      e instanceof Error ? e.message : String(e)
    );
    return { ...ruleBasedConsequences(report), degraded: degradedReason(e) };
  }
}

/** Say which failure this was, in terms an operator can act on. */
function degradedReason(e: unknown): string {
  const tail = ", so this is a rules-based summary rather than a model's reasoning.";
  if (!(e instanceof QuotaExhausted)) {
    return "The model could not be reached" + tail;
  }
  switch (e.reason) {
    case "credits":
      return "The Gemini project has no prepaid credit left" + tail;
    case "daily-quota":
      return "Every configured model has spent its daily request quota" + tail;
    default:
      return "Every configured model is rate limited right now" + tail;
  }
}

/**
 * A refused write has a changeCount of zero, so dependent rows cannot be
 * inferred by subtraction -- that produced "plus -2 dependent row(s)".
 */
function purgeSummary(report: SimulationReport): string {
  const acting = report.summary.acting;
  const dependents = Math.max(0, report.proven.changeCount - acting);
  if (report.proven.changeCount === 0) {
    return `${acting} customer record(s) targeted; the database refused the write.`;
  }
  return dependents
    ? `${acting} customer record(s) change, plus ${dependents} dependent row(s).`
    : `${acting} customer record(s) change.`;
}
