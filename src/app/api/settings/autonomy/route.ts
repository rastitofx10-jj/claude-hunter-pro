import { NextRequest, NextResponse } from "next/server";
import {
  readAutonomyConfig,
  writeAutonomyConfig,
  triggerAutonomousCycle,
  cycleInFlight,
  cycleBlockedReason,
  DAILY_MIN_GAP_MS,
} from "@/lib/scheduler-cycle";

// ============================================================
// The autonomy switch — opting the server into the daily
// intelligence cycle (harvest + sweep, once per ~20h, run by the
// scheduler with NO browser involved).
//
// GET  — the current config + when the next cycle may fire
// POST — { mode: "off" | "daily" } flips the switch
//        { trigger: true }  fires the cycle NOW (manual kick —
//        respects the same in-process locks as the scheduled one)
// ============================================================

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializeNextCycle(cfg: {
  mode: string;
  lastCycleAt?: string;
}): { mode: string; lastCycleAt: string | null; nextCycleAt: string | null } {
  const last = cfg.lastCycleAt ? Date.parse(cfg.lastCycleAt) : Number.NaN;
  const next =
    cfg.mode === "daily" && Number.isFinite(last)
      ? new Date(last + DAILY_MIN_GAP_MS).toISOString()
      : cfg.mode === "daily"
        ? new Date(Date.now() + 60_000).toISOString() // just enabled — the next tick may fire it
        : null;
  return {
    mode: cfg.mode,
    lastCycleAt: cfg.lastCycleAt ?? null,
    nextCycleAt: next,
  };
}

export async function GET() {
  try {
    const cfg = await readAutonomyConfig();
    // Round 14: the in-flight flag rides along — the UI shows "a cycle is running
    // right now" (or "the previous sweep still is") instead of a clickable
    // button that silently no-ops.
    return NextResponse.json({
      ...serializeNextCycle(cfg),
      cycleInFlight: cycleInFlight(),
      blockedBy: await cycleBlockedReason(),
    });
  } catch {
    return NextResponse.json({ error: "Failed to read the autonomy config" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { mode?: unknown; trigger?: unknown };
  try {
    body = (await req.json()) as { mode?: unknown; trigger?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    if (body.trigger === true) {
      // Round 14 honesty fix: the OLD code always answered `triggered: true, "the
      // cycle is starting"` — even when the in-process lock rejected the request and
      // NOTHING started. The user clicked again, got the same cheerful lie, and saw
      // no effect at all ("it failed to launch"). Now the second click gets the truth:
      // a cycle or its sweep is already in flight, and when it is not.
      const blocked = await cycleBlockedReason();
      if (blocked) {
        const cfg = await readAutonomyConfig();
        return NextResponse.json({
          ...serializeNextCycle(cfg),
          cycleInFlight: blocked === "cycle",
          blockedBy: blocked,
          triggered: false,
          note:
            blocked === "cycle"
              ? "A cycle is already in flight right now — it finishes on its own; watch the live feed"
              : "The previous cycle's deep sweep is still running — the next cycle will fire after it lands",
        });
      }
      // Manual kick — force=true bypasses the mode/gap checks by design
      // (an explicit human action), still guarded by the in-process lock.
      // It does NOT persistently enable daily mode.
      triggerAutonomousCycle();
      const cfg = await readAutonomyConfig();
      return NextResponse.json({
        ...serializeNextCycle(cfg),
        cycleInFlight: true,
        triggered: true,
        note: "The autonomous cycle is starting — watch the live feed",
      });
    }

    const mode = body.mode === "daily" ? "daily" : body.mode === "off" ? "off" : null;
    if (!mode) {
      return NextResponse.json({ error: 'mode must be "off" or "daily"' }, { status: 400 });
    }

    const cfg = await readAutonomyConfig();
    await writeAutonomyConfig({
      mode,
      lastCycleAt: mode === "daily" ? cfg.lastCycleAt : undefined,
      lastResult: cfg.lastResult,
    });
    return NextResponse.json(serializeNextCycle(await readAutonomyConfig()));
  } catch {
    return NextResponse.json({ error: "Failed to update the autonomy config" }, { status: 500 });
  }
}
