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
  // round 11: the teardown is hoisted OUT of start() and the write-catch now
  // CALLS it. Before, an enqueue throw only flipped `closed = true` — if the
  // runtime then never delivered the abort/cancel (a real possibility), the
  // listener stayed subscribed and the 15s heartbeat kept no-op'ing for the
  // connection's lifetime: a leak with a pulse. Also, the old cleanup()
  // bailed early on `closed` — the very flag the write-catch had just set —
  // so even calling it would have been a no-op. teardown is idempotent on
  // its own (nulling every resource), not via the flag.
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      teardown = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the runtime — fine
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // the client vanished mid-write — release the listener + heartbeat
          // NOW, not "when the abort signal maybe fires"
          teardown?.();
        }
      };

      // welcome packet — the client flips its "LIVE" indicator on this.
      // If this very first write throws (client gone before connect), teardown
      // already released everything — do NOT subscribe/heartbeat on a dead stream.
      write(`event: hello\ndata: ${JSON.stringify({ kind: "hello", t: Date.now() })}\n\n`);
      if (closed) return;

      unsubscribe = subscribeEvents((e: HunterEvent) => {
        write(`event: hunter\ndata: ${JSON.stringify(e)}\n\n`);
      });

      heartbeat = setInterval(() => {
        // comment lines are ignored by EventSource but reset idle timers
        write(`: hb ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      // client disconnect / page close / refresh
      req.signal.addEventListener("abort", () => teardown?.());
    },
    cancel() {
      // the runtime tore the stream down (client gone) — same release path
      teardown?.();
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
