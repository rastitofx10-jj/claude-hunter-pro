// Reflexion API — the inward loop's control surface.
// GET  : history (last runs with truth-gate verdicts) + live pool + quick telemetry
// POST : run a reflexion NOW (analyzes the hunter's own telemetry via LLM,
//        births self-DNA, may add validated queries to the live hunt pool)

import { NextResponse } from "next/server";
import { runReflexion, readReflexionHistory, readReflexionPool, gatherReflexionTelemetry } from "@/lib/reflexion";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [history, pool, telemetry] = await Promise.all([
      readReflexionHistory(),
      readReflexionPool(),
      gatherReflexionTelemetry(),
    ]);
    const last = history[history.length - 1] ?? null;
    return NextResponse.json({
      history: [...history].reverse(), // newest first for the UI
      pool,
      telemetry: {
        libraryTotal: telemetry.library.total,
        bornLast7d: telemetry.library.bornLast7d,
        missionsTotal: telemetry.missions.total,
        sweepsTotal: telemetry.sweeps.total,
        huntsTotal: telemetry.hunts.total,
        trackedQueries: telemetry.yieldStats.tracked,
        sterileQueries: telemetry.yieldStats.sterile.length,
      },
      lastRunAt: last?.at ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to read reflexion state" },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    // The long analysis runs inside the request (same pattern as the other
    // engine endpoints: the caller gets the FULL truth-gated result back).
    const run = await runReflexion();
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "reflexion failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
