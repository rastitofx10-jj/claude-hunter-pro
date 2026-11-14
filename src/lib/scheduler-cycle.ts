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
  if (cycleRunning) return false;

  if (!force) {
    const cfg = await readAutonomyConfig();
    if (cfg.mode !== "daily") return false;
    const last = cfg.lastCycleAt ? Date.parse(cfg.lastCycleAt) : Number.NaN;
    if (Number.isFinite(last) && Date.now() - last < DAILY_MIN_GAP_MS) return false;
  }

  cycleRunning = true;
  try {
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

    await writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));

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
