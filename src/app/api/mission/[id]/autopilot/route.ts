import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runNextAutopilotPhase, AutopilotError, parseAutopilotState } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// round 8: the loop allowed up to 4 sequential phases against a declared 300s budget —
// the sibling step route documents the per-phase worst case at ~220s (2 attempts × 110s
// timeout + queue wait). 4 × 220 = 880s: any enforced budget kills the request mid-run,
// the client sees a failure even though phases persisted. Now: a phase only STARTS if
// its worst case still fits the remaining budget (~270s safe window), so 1–2 typical
// phases fit and the honest `remaining` field tells the client to keep stepping.
const RUN_BUDGET_MS = 270_000;
const PHASE_WORST_CASE_MS = 220_000;

/**
 * Full run (backward compatible): runs stage-by-stage through the exact same engine
 * (runNextAutopilotPhase) with a cap on stages per single run.
 * The preferred interface is client-driven stepping — a continuous run remains here for manual/automation use.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  }

  try {
    // Stages already executed in previous runs — must be included in remaining,
    // otherwise a 6-stage mission with 2 done reported remaining: 2 even when 4 were left
    const pre = await db.mission.findUnique({ where: { id: numId }, select: { autopilot: true } });
    const preState = parseAutopilotState(pre?.autopilot ?? null);
    const preDone = preState.steps.length + preState.failures.length;

    const steps: NonNullable<Awaited<ReturnType<typeof runNextAutopilotPhase>>["executed"]>[] = [];
    const failures: { phaseIndex: number; error: string }[] = [];
    let totalPhases = 0;
    let firstRun = true;

    // Loop over the same step-by-step engine — until there are no more stages
    const runStart = Date.now();
    let finalState = preState;
    for (;;) {
      if (Date.now() - runStart + PHASE_WORST_CASE_MS > RUN_BUDGET_MS) break; // worst case no longer fits — stop honestly
      const r = await runNextAutopilotPhase(numId);
      totalPhases = r.totalPhases;
      finalState = r.state;
      if (firstRun && r.done && r.executed === null && r.failure === null) {
        // The mission was already fully executed — not an error, there is simply nothing to run
        return NextResponse.json({
          ok: true,
          steps: r.state.steps,
          failures: r.state.failures,
          totalPhases,
          remaining: 0,
          alreadyComplete: true,
        });
      }
      firstRun = false;
      if (r.executed) steps.push(r.executed);
      if (r.failure) failures.push(r.failure);
      if (r.allDone || r.done) break;
      if (!r.executed && !r.failure) break; // stuck — do not get stuck in the loop
    }

    if (steps.length === 0 && preDone === 0) {
      // Round 9 — transient/permanent discrimination: one transient failure (a
      // phase that timed out, explicitly retryable by the engine's own semantics)
      // used to end here as a permanent 500 "All stages failed" while the DB held
      // an in_progress mission with a pending retryable phase — automation callers
      // treated it as final and abandoned a recoverable mission. Now: 500 only
      // when every failure is permanent; a transiently-failing run returns ok:true
      // with the failure + remaining so the caller re-steps.
      const allPermanent = failures.every((f) => {
        // the route's failure shape lacks the transient flag — resolve against the
        // FINAL state, which carries the full semantics
        const match = finalState.failures.find((x) => x.phaseIndex === f.phaseIndex && x.error === f.error);
        const transient = match ? match.transient === true && (match.attempts ?? 0) < 2 : false;
        return !transient;
      });
      if (allPermanent) {
        const detail = failures.map((f) => `Stage ${f.phaseIndex + 1}: ${f.error}`).join(" · ");
        return NextResponse.json(
          { error: `All stages failed${detail ? `: ${detail}` : ""}` },
          { status: 500 }
        );
      }
      // transient — the mission is recoverable; report honestly instead of 500
      return NextResponse.json({
        ok: true,
        steps,
        failures,
        totalPhases,
        remaining: 1,
        note: "The first stage failed transiently (retryable). Re-run the autopilot — the engine retries transient phases.",
      });
    }

    // round 8: the old formula `totalPhases - (preDone + steps.length + failures.length)`
    // DOUBLE-COUNTED a phase that failed transiently and then succeeded on retry (it sat
    // in both pre-state failures and this run's steps) — remaining was under-reported and
    // superseded failures were shown as final. Computed from the FINAL state instead:
    // remaining = phases neither executed nor permanently failed.
    const executedIdx = new Set(finalState.steps.map((s) => s.phaseIndex));
    const permFailedIdx = new Set(
      finalState.failures.filter((f) => !f.transient || (f.attempts ?? 2) >= 2).map((f) => f.phaseIndex),
    );
    const pendingCount = Array.from({ length: totalPhases }, (_, i) => i)
      .filter((i) => !executedIdx.has(i) && !permFailedIdx.has(i)).length;

    return NextResponse.json({
      ok: true,
      steps,
      failures,
      totalPhases,
      // remaining = stages not yet executed, both from previous runs and from this one
      remaining: pendingCount,
    });
  } catch (e) {
    if (e instanceof AutopilotError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    // Sanitization — previously a raw e.message (Prisma/network) leaked to the client
    console.error("[mission:autopilot] failed", e);
    return NextResponse.json({ error: "The autonomous run failed" }, { status: 500 });
  }
}
