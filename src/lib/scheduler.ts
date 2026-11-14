// ============================================================
// The Hunter Scheduler — the server's own heartbeat.
//
// Before v0.4.0 the whole system was DRIVEN BY THE BROWSER:
// - an autopilot/hunt advanced only while a tab kept POSTing "next"
//   (close the tab → the run freezes mid-chain forever);
// - stale-run reapers ran only when a user happened to open a panel;
// - the daily intelligence cycle existed as an external script
//   (scripts/daily-cycle.mjs) shelling HTTP against localhost —
//   a human had to remember to run it.
//
// This module is started once per server process (see
// src/instrumentation.ts) and every TICK_MS it:
//   1. reaps stale sweep/hunt rows (crash recovery — no user needed);
//   2. takes over ORPHANED missions' autopilot (in_progress, pending
//      phases, no progress for MISSION_ORPHAN_MS) — one phase/tick;
//   3. takes over orphaned live hunts — one stage/tick;
//   4. optionally runs the DAILY AUTONOMOUS CYCLE (opt-in): harvest
//      elite repos + launch a deep sweep, once per ~20h.
//
// Safety properties (each backed by the engines' own machinery):
// - per-mission/per-hunt in-process locks serialize the scheduler
//   against a live client pump — a phase executes exactly once;
// - the takeover only ever CONTINUES what was already started: a
//   "compiled" mission that never ran autopilot is never auto-started;
// - one takeover per tick — the LLM queue is never flooded;
// - a tick never overlaps itself (tickRunning) and never throws.
//
// Single-process assumption: honest and documented — the locks and the
// scheduler live in one process, exactly like the existing engines.
// ============================================================

import { db } from "./db";
import { safeJsonParse } from "./ai-json";
import { runNextAutopilotPhase, parseAutopilotState } from "./autopilot";
import { runNextLiveHuntStage, reapStaleHunts } from "./live-hunt";
import { reapStaleRuns } from "./sweep-runner";
import { runDailyCycle } from "./scheduler-cycle";
import { emitAutonomy } from "./event-bus";

const TICK_MS = 10_000;
/** A mission with pending phases not progressed for 4 min = its driver is gone */
const MISSION_ORPHAN_MS = 4 * 60_000;
/** A running hunt not updated for 5 min = its pump is gone */
const HUNT_ORPHAN_MS = 5 * 60_000;

let started = false;
let tickRunning = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Idempotent — called once from instrumentation.register() */
export function startScheduler(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // never keep the process alive just for the scheduler
  (timer as unknown as { unref?: () => void }).unref?.();
  console.log("[scheduler] started — 10s heartbeat, orphan takeover, autonomy watchdog");
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** One heartbeat — never throws, never overlaps itself */
async function tick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    // 1. crash recovery — cheap updateMany calls, safe every tick
    await reapStaleRuns();
    await reapStaleHunts();

    // 2. continue orphaned mission autopilots (one phase per tick)
    await advanceOrphanMission();

    // 3. continue orphaned live hunts (one stage per tick)
    await advanceOrphanHunt();

    // 4. the opt-in daily intelligence cycle
    await runDailyCycle(false);
  } catch (e) {
    // telemetry-grade: a broken tick must never kill the interval
    console.error("[scheduler] tick failed:", e);
  } finally {
    tickRunning = false;
  }
}

/**
 * Take over ONE mission whose autopilot stalled: status in_progress, at least
 * one pending phase, and no progress for MISSION_ORPHAN_MS.
 * "compiled" missions are deliberately untouched — the scheduler continues
 * chains that were started, it never starts new work on its own (the daily
 * cycle is the one explicit opt-in exception).
 */
async function advanceOrphanMission(): Promise<void> {
  try {
    const rows = await db.mission.findMany({
      where: { status: "in_progress" },
      select: { id: true, plan: true, autopilot: true, autopilotAt: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });

    for (const row of rows) {
      const lastMs = (row.autopilotAt ?? row.updatedAt).getTime();
      if (Date.now() - lastMs < MISSION_ORPHAN_MS) continue; // someone is driving it

      const plan = safeJsonParse<{ phases?: unknown[] }>(row.plan, {});
      const phaseCount = Array.isArray(plan?.phases) ? plan.phases.length : 0;
      if (phaseCount === 0) continue;

      const state = parseAutopilotState(row.autopilot);
      const executed = new Set(state.steps.map((s) => s.phaseIndex));
      const failedPermanent = new Set(
        state.failures
          .filter((f) => !f.transient || (f.attempts ?? 2) >= 2)
          .map((f) => f.phaseIndex),
      );
      let pending = 0;
      for (let i = 0; i < phaseCount; i++) {
        if (!executed.has(i) && !failedPermanent.has(i)) pending++;
      }
      if (pending === 0) continue; // everything closed — waiting for a field report, not our job

      // take it over — the per-mission lock serializes against any live pump
      const res = await runNextAutopilotPhase(row.id);
      emitAutonomy({
        note: `scheduler took over mission #${row.id} — phase ${res.stepsDone}/${res.totalPhases}`,
        mode: "watchdog",
      });
      return; // one phase per tick — the LLM queue stays calm
    }
  } catch (e) {
    console.error("[scheduler] orphan-mission advance failed:", e);
  }
}

/** Take over ONE running hunt whose client pump is gone (one stage per tick) */
async function advanceOrphanHunt(): Promise<void> {
  try {
    const rows = await db.liveHunt.findMany({
      where: { status: "running" },
      select: { id: true, updatedAt: true },
      orderBy: { id: "desc" },
      take: 5,
    });

    for (const row of rows) {
      if (Date.now() - row.updatedAt.getTime() < HUNT_ORPHAN_MS) continue; // pump alive

      const state = await runNextLiveHuntStage(row.id);
      emitAutonomy({
        note: `scheduler took over hunt #${row.id} — stage "${state.stageKey}"`,
        mode: "watchdog",
      });
      return; // one stage per tick
    }
  } catch (e) {
    // 409s (hunt just failed/was reaped between read and call) are routine here
    console.error("[scheduler] orphan-hunt advance failed:", e);
  }
}

/** Read the autonomy config (re-exported for convenience) */
export { readAutonomyConfig, writeAutonomyConfig, AUTONOMY_KEY } from "./scheduler-cycle";
export type { AutonomyConfig } from "./scheduler-cycle";
