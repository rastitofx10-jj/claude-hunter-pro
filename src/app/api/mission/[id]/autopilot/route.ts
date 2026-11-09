import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runNextAutopilotPhase, AutopilotError, parseAutopilotState } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PHASES_PER_RUN = 4;

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
    for (;;) {
      if (steps.length + failures.length >= MAX_PHASES_PER_RUN) break;
      const r = await runNextAutopilotPhase(numId);
      totalPhases = r.totalPhases;
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
      const detail = failures.map((f) => `Stage ${f.phaseIndex + 1}: ${f.error}`).join(" · ");
      return NextResponse.json(
        { error: `All stages failed${detail ? `: ${detail}` : ""}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      steps,
      failures,
      totalPhases,
      // remaining = stages not yet executed, both from previous runs and from this one
      remaining: Math.max(0, totalPhases - (preDone + steps.length + failures.length)),
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
