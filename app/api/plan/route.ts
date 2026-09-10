import { NextResponse } from "next/server";
import { planFromIntent, geminiEnabled } from "@/lib/llm/gemini";
import { claimAiCall, currentTenant } from "@/lib/session";
import { DEFECT_BATCH } from "@/lib/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** Natural language in, a validated ActionPlan out. */
export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  if (!geminiEnabled()) {
    return NextResponse.json(
      { error: "No model configured. Use one of the preset intents." },
      { status: 503 }
    );
  }

  const { intent } = (await req.json().catch(() => ({}))) as { intent?: string };
  if (!intent || intent.trim().length < 4) {
    return NextResponse.json({ error: "Say what you want to do." }, { status: 400 });
  }
  if (intent.length > 400) {
    return NextResponse.json({ error: "That request is too long." }, { status: 400 });
  }

  if (!(await claimAiCall(tenantId))) {
    return NextResponse.json(
      { error: "This sandbox has used its model calls for today. The preset intents still work." },
      { status: 429 }
    );
  }

  try {
    const planned = await planFromIntent(intent.trim(), {
      defectBatches: [DEFECT_BATCH],
      today: new Date().toISOString().slice(0, 10),
    });
    return NextResponse.json(planned);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not turn that into a plan: ${e instanceof Error ? e.message : String(e)}` },
      { status: 422 }
    );
  }
}
