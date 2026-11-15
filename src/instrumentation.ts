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
  // Round 14 — FIRST, before anything that touches GitHub: re-seed the PAT from
  // the durable mirror if the sandbox recycle wiped db/custom.db. Field fact
  // (3× recycles so far): the library self-heal restores genes/hunts/sweeps but
  // never the token, so "Start an autonomous live hunt" failed with 400
  // "No GitHub token" after every recycle until the human re-pasted the PAT.
  // This is a file read + one upsert (~ms) — awaited, so even the very first
  // user request already sees a working token. Never throws.
  try {
    const { restoreTokenFromFile } = await import("./lib/server-token");
    await restoreTokenFromFile();
  } catch (e) {
    console.error("[instrumentation] token mirror restore failed:", e);
  }
  try {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  } catch (e) {
    // the app must still boot if the heartbeat fails to start —
    // hunts/sweeps simply stay client-driven as before
    console.error("[instrumentation] scheduler failed to start:", e);
  }
  try {
    // round 11 — the library's immune system fires at boot: the sandbox
    // recycles and wipes db/custom.db between sessions (twice on 2026-11-14;
    // the DB sat at 64 genes while the snapshot held 1849). Until now the
    // wipe was detected only when a snapshot attempt hit the regression
    // ratchet — and the "detection" was a console.error a human had to act
    // on. Now the app measures itself against the disaster-recovery file
    // the moment it boots and heals the library automatically (idempotent,
    // id-preserving, emits dna-born/autonomy events the UI shows live).
    // Fire-and-forget: a ~1-minute restore must never block the first paint.
    const { autoRestoreIfWiped } = await import("./lib/dna-restore");
    void autoRestoreIfWiped().catch(() => undefined);
  } catch (e) {
    console.error("[instrumentation] library self-heal check failed to start:", e);
  }
}
