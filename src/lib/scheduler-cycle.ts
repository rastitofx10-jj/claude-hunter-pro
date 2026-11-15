// ============================================================
// The autonomous daily cycle — the concrete work the scheduler
// performs when autonomy is ON (and what POST /api/settings/autonomy
// { trigger: true } fires manually).
//
// Sequence: harvest elite repos (discover + mine) → launch a deep
// sweep in the background → snapshot the library → record the
// result in the Setting row the UI reads.
//
// Guards: in-process lock (no overlapping cycles), DAILY_MIN_GAP_MS
// between scheduled fires (manual trigger bypasses the gap by
// design — it's an explicit human action), and every failure is
// recorded + emitted, never thrown.
// ============================================================

import { db } from "./db";
import { safeJsonParse } from "./ai-json";
import { harvest } from "./harvester";
import { beginSweep } from "./sweep-runner";
import { resolveServerToken } from "./server-token";
import { writeDnaSnapshot } from "./dna-snapshot";
import { emitAutonomy } from "./event-bus";
import { triggerReflexion } from "./reflexion";

/** The daily cycle may not fire more often than this (drift-tolerant "daily") */
export const DAILY_MIN_GAP_MS = 20 * 60 * 60_000;

/** Setting key holding the autonomy config (JSON): { mode, lastCycleAt, lastResult } */
export const AUTONOMY_KEY = "autonomy";

export interface AutonomyConfig {
  mode: "off" | "daily";
  lastCycleAt?: string;
  lastResult?: {
    at: string;
    harvested: number;
    newGenes: number;
    sweepId: number | null;
    note: string;
  };
}

let cycleRunning = false;

/** Round 14: is a cycle executing right now (in THIS process)? The API layer
 * reports it to the UI so "Run the cycle now" can show live state instead of
 * silently no-op'ing on a second click while the first cycle is still in flight. */
export function cycleInFlight(): boolean {
  return cycleRunning;
}

/** Read the autonomy config (missing row = off) */
export async function readAutonomyConfig(): Promise<AutonomyConfig> {
  try {
    const row = await db.setting.findUnique({ where: { key: AUTONOMY_KEY } });
    const parsed = safeJsonParse<Partial<AutonomyConfig>>(row?.value, {});
    return {
      mode: parsed.mode === "daily" ? "daily" : "off",
      lastCycleAt: typeof parsed.lastCycleAt === "string" ? parsed.lastCycleAt : undefined,
      lastResult: parsed.lastResult ?? undefined,
    };
  } catch {
    return { mode: "off" };
  }
}

/** Write the autonomy config (upsert) */
export async function writeAutonomyConfig(cfg: AutonomyConfig): Promise<void> {
  await db.setting.upsert({
    where: { key: AUTONOMY_KEY },
    create: { key: AUTONOMY_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
}

/**
 * The cycle itself. `force: true` skips the mode/gap checks (manual trigger) but
 * still respects the in-process lock. Returns true if a cycle actually ran.
 */
export async function runDailyCycle(force: boolean): Promise<boolean> {
  // round 11: the lock is taken BEFORE the first await — same synchronous
  // discipline as every other lock in this codebase (startingSweep,
  // startingHunt, publishingDrafts). The old order (check → await config →
  // set flag) left a DB-round-trip window where a scheduler tick and a manual
  // POST /api/settings/autonomy {trigger:true} BOTH passed the flag check and
  // ran the FULL cycle twice — double harvest = double GitHub quota burn.
  if (cycleRunning) return false;
  cycleRunning = true;
  try {
    if (!force) {
      const cfg = await readAutonomyConfig();
      if (cfg.mode !== "daily") return false;
      const last = cfg.lastCycleAt ? Date.parse(cfg.lastCycleAt) : Number.NaN;
      if (Number.isFinite(last) && Date.now() - last < DAILY_MIN_GAP_MS) return false;
    }

    // Round 14: the previous cycle's sweep keeps running ~10 minutes AFTER the
    // cycle function itself returned. Firing a fresh cycle on top of it doubles
    // the harvest quota for nothing — skip honestly and say so in the feed.
    const sweepBusy = await db.sweepRun.findFirst({ where: { status: "running" }, select: { id: true } });
    if (sweepBusy) {
      emitAutonomy({ note: `cycle held — the previous sweep #${sweepBusy.id} is still in flight` });
      return false;
    }

    const startedAt = new Date().toISOString();
    // record the fire time immediately — a 6-minute cycle ticking every 10s
    // must not double-fire (in-process lock covers same-process races; the
    // gap check covers restarts). Manual trigger does NOT silently flip the
    // persistent mode switch — a one-off kick and opting-in are different actions.
    const before = await readAutonomyConfig();
    await writeAutonomyConfig({ ...before, lastCycleAt: startedAt });
    emitAutonomy({ note: "daily autonomous cycle started", mode: before.mode });

    const token = await resolveServerToken();
    const harv = await harvest(token, 6);

    let sweepId: number | null = null;
    try {
      const s = await beginSweep(token);
      sweepId = s.id;
    } catch {
      // a sweep is already running (user-initiated) — the cycle still counts
    }

    // Round 14: mid-cycle feedback — before this, the live feed went QUIET for the
    // whole 4-6 minute harvest (only "started" and "done" bracketed it), which the
    // user reasonably read as "it failed to launch". One event per real milestone.
    emitAutonomy({
      note: `cycle: harvest ${harv.reposMined.length} repo(s), +${harv.artifactsAdded} genes${sweepId ? `, deep sweep #${sweepId} launched` : ", sweep skipped (one already running)"}`,
      mode: before.mode,
    });

    await writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));

    // Reflexion: after the cycle created fresh telemetry (harvest yields, sweep
    // stats, new genes) the hunter analyzes its OWN performance and may propose
    // new queries — the inward loop closes. Fire-and-forget by design: the daily
    // cycle's own result is already complete; reflection failure is logged by the
    // engine itself and surfaces in /api/reflexion + the reflexion tab.
    triggerReflexion();

    const result: AutonomyConfig["lastResult"] = {
      at: startedAt,
      harvested: harv.reposMined.length,
      newGenes: harv.artifactsAdded,
      sweepId,
      note: `harvest ${harv.reposMined.length} repo(s), +${harv.artifactsAdded} genes${sweepId ? `, sweep #${sweepId} launched` : ""}`,
    };
    const fresh = await readAutonomyConfig();
    await writeAutonomyConfig({ ...fresh, lastCycleAt: startedAt, lastResult: result });
    emitAutonomy({ note: `daily cycle done — ${result.note}`, mode: fresh.mode });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 180) : "unknown error";
    emitAutonomy({ note: `daily cycle failed — ${msg}`, mode: "daily" });
    console.error("[scheduler] daily cycle failed:", e);
    return false;
  } finally {
    cycleRunning = false;
  }
}

/** Fire-and-forget manual trigger (API route) — never blocks the response */
export function triggerAutonomousCycle(): void {
  void runDailyCycle(true).catch(() => undefined);
}

/** Round 14: honest pre-flight for the manual trigger — a fresh cycle would sit on
 * the previous cycle's still-running sweep and duplicate the harvest quota burn.
 * The route reports BOTH the in-process cycle flag and the sweep state so the
 * user gets "it is already running" instead of a no-op. */
export async function cycleBlockedReason(): Promise<"cycle" | "sweep" | null> {
  if (cycleRunning) return "cycle";
  const sweepBusy = await db.sweepRun.findFirst({ where: { status: "running" }, select: { id: true } });
  return sweepBusy ? "sweep" : null;
}
