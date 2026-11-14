import { NextRequest, NextResponse } from "next/server";
import {
  readAutonomyConfig,
  writeAutonomyConfig,
  triggerAutonomousCycle,
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
    return NextResponse.json(serializeNextCycle(cfg));
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
      // Manual kick — force=true bypasses the mode/gap checks by design
      // (an explicit human action), still guarded by the in-process lock.
      // It does NOT persistently enable daily mode.
      triggerAutonomousCycle();
      const cfg = await readAutonomyConfig();
      return NextResponse.json({
        ...serializeNextCycle(cfg),
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
