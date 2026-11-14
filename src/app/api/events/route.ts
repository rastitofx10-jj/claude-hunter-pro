import { NextRequest } from "next/server";
import { subscribeEvents, eventConnections, type HunterEvent } from "@/lib/event-bus";

// ============================================================
// Server-Sent Events endpoint — the browser's live feed.
//
// Wire format (single event name "hunter", JSON payload):
//   event: hunter
//   data: {"kind":"sweep","t":1731400000000,"runId":42,"phase":"mine","progress":52}
//
// Plus a "hello" event on connect (lets the client confirm the
// stream is alive) and comment-line heartbeats every 15s (keeps
// proxies from closing an idle connection).
//
// Guards:
// - connection cap (MAX_CONNECTIONS) — an open tab holds exactly one
//   connection; a leak of N tabs must not hold N silent listeners.
// - abort cleanup — the unsubscribe + interval are released when the
//   client goes away, otherwise every page refresh leaked a listener.
// ============================================================

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // long-lived stream

const MAX_CONNECTIONS = 12;
const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest) {
  if (eventConnections() >= MAX_CONNECTIONS) {
    return new Response(
      JSON.stringify({ error: "Too many live event connections — close a tab or retry shortly" }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "10" } },
    );
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // the client vanished mid-write — cleanup below will handle it
          closed = true;
        }
      };

      // welcome packet — the client flips its "LIVE" indicator on this
      write(`event: hello\ndata: ${JSON.stringify({ kind: "hello", t: Date.now() })}\n\n`);

      unsubscribe = subscribeEvents((e: HunterEvent) => {
        write(`event: hunter\ndata: ${JSON.stringify(e)}\n\n`);
      });

      heartbeat = setInterval(() => {
        // comment lines are ignored by EventSource but reset idle timers
        write(`: hb ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      // client disconnect / page close / refresh
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // hints for reverse proxies (Caddy) not to buffer the stream
      "X-Accel-Buffering": "no",
    },
  });
}
