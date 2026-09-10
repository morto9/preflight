import { NextResponse } from "next/server";
import { simulate } from "@/lib/gateway";
import { ActionPlan } from "@/lib/plan/schema";
import { consequencesFor } from "@/lib/llm/gemini";
import { currentTenant, touchTenant } from "@/lib/session";
import { findPreset } from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) {
    return NextResponse.json({ error: "No sandbox. Provision one first." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    presetId?: string;
    plan?: unknown;
    intent?: string;
  };

  const source = body.presetId ? findPreset(body.presetId) : undefined;
  const rawPlan = source ? source.plan : body.plan;
  if (!rawPlan) {
    return NextResponse.json({ error: "No plan supplied." }, { status: 400 });
  }

  const parsed = ActionPlan.safeParse(rawPlan);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That plan is not valid.", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    await touchTenant(tenantId);

    const report = await simulate({
      tenantId,
      plan: parsed.data,
      intent: source?.intent ?? body.intent,
    });

    // The consequence model is advisory. It must never break a simulation, and
    // its output is labelled as a prediction in the UI.
    report.consequences = await consequencesFor(report);

    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
