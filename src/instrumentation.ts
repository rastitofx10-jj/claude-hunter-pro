// ============================================================
// Next.js instrumentation hook — runs ONCE per server process,
// before any request is served.
//
// This is where the Hunter Scheduler (the server's heartbeat:
// orphan-run takeover, stale reaping, the autonomous daily cycle)
// comes to life. Without it, the whole app was browser-driven —
// closing the tab froze every running chain.
//
// NEXT_RUNTIME guard: the hook also fires in the edge runtime where
// the scheduler's Node APIs and DB access don't apply.
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  } catch (e) {
    // the app must still boot if the heartbeat fails to start —
    // hunts/sweeps simply stay client-driven as before
    console.error("[instrumentation] scheduler failed to start:", e);
  }
}
