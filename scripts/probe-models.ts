import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

/**
 * Which front doors actually open?
 *
 * Calls every configured backend once and prints what came back, instead of
 * letting consequencesFor() fold it all into one rules-based summary. Run it
 * whenever the predicted panel says it is degraded and you want to know why.
 */

const VERTEX = "https://aiplatform.googleapis.com/v1/publishers/google/models";
const STUDIO = "https://generativelanguage.googleapis.com/v1beta/models";

type Attempt = { label: string; url: string; headers: Record<string, string> };

function mask(key: string): string {
  return key.slice(0, 6) + "..." + key.slice(-4) + " (len " + key.length + ")";
}

function attempts(): Attempt[] {
  const out: Attempt[] = [];
  const vertex = process.env.VERTEX_API_KEY;
  const studio = process.env.GEMINI_API_KEY;

  if (vertex) {
    console.log("VERTEX_API_KEY  " + mask(vertex));
    for (const m of (process.env.VERTEX_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite").split(",")) {
      const model = m.trim();
      if (!model) continue;
      out.push({
        label: "vertex/" + model + " [header]",
        url: VERTEX + "/" + model + ":generateContent",
        headers: { "content-type": "application/json", "x-goog-api-key": vertex },
      });
      // The documented form is a query parameter; worth knowing if only it works.
      out.push({
        label: "vertex/" + model + " [?key=]",
        url: VERTEX + "/" + model + ":generateContent?key=" + encodeURIComponent(vertex),
        headers: { "content-type": "application/json" },
      });
    }
  }

  if (studio) {
    console.log("GEMINI_API_KEY  " + mask(studio));
    const models = [
      process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
      ...(process.env.GEMINI_MODEL_FALLBACKS || "gemini-2.5-flash").split(","),
    ];
    for (const m of [...new Set(models.map((x) => x.trim()).filter(Boolean))]) {
      out.push({
        label: "ai-studio/" + m,
        url: STUDIO + "/" + m + ":generateContent",
        headers: { "content-type": "application/json", "x-goog-api-key": studio },
      });
    }
  }

  return out;
}

function detail(body: string): string {
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(body) as any;
    const v = j?.error?.details?.find((d: any) => d?.violations)?.violations?.[0];
    if (v?.quotaId) return v.quotaId + " limit=" + (v.quotaValue ?? "?");
    const reason = j?.error?.details?.find((d: any) => d?.reason)?.reason ?? "";
    return [reason, j?.error?.message ? flat(j.error.message) : ""].filter(Boolean).join(": ").slice(0, 220);
  } catch {}
  return flat(body).slice(0, 220);
}

async function main() {
  const chain = attempts();
  if (!chain.length) {
    console.log("No key configured. Set VERTEX_API_KEY or GEMINI_API_KEY.");
    return;
  }
  console.log("");

  for (const a of chain) {
    const t0 = Date.now();
    try {
      const res = await fetch(a.url, {
        method: "POST",
        headers: a.headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with the single word: ok" }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { word: { type: "STRING" } }, required: ["word"] },
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(2);
      if (res.ok) {
        console.log("  OK    " + a.label.padEnd(36) + secs + "s");
      } else {
        console.log("  " + String(res.status).padEnd(5) + a.label.padEnd(36) + secs + "s  " + detail(await res.text().catch(() => "")));
      }
    } catch (e) {
      console.log("  ERR   " + a.label.padEnd(36) + (e instanceof Error ? e.message : String(e)));
    }
  }
}

main();
