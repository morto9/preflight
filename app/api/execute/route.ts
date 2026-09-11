import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { execute, type ExecEvent, type ExecutionReport } from "@/lib/gateway";
import { currentTenant } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Execution, streamed.
 *
 * The whole point of staging a write behind a canary is that a human can watch
 * it happen and see the breaker trip. Returning only the final report hid that
 * behind a spinner, so progress is pushed as server-sent events and the outcome
 * arrives as the last one.
 */
export async function POST(req: Request) {
  const tenantId = await currentTenant();
  if (!tenantId) return NextResponse.json({ error: "No sandbox." }, { status: 401 });

  const { runId, token } = (await req.json().catch(() => ({}))) as {
    runId?: string;
    token?: string;
  };
  if (!runId || !token) {
    return NextResponse.json({ error: "runId and token are required." }, { status: 400 });
  }

  const [run] = await db()`
    select id from preflight.runs where id = ${runId}::uuid and tenant_id = ${tenantId}`;
  if (!run) return NextResponse.json({ error: "Unknown run." }, { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ExecEvent | { type: "done"; report: ExecutionReport } | { type: "error"; error: string }) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const report = await execute({ runId, token, onEvent: send });
        send({ type: "done", report });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces against any intermediary that would buffer the stream.
      "x-accel-buffering": "no",
    },
  });
}
