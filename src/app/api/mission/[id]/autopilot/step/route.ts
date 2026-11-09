import { NextRequest, NextResponse } from "next/server";
import { runNextAutopilotPhase, AutopilotError } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
// worst-case in one step: 2 attempts × 110s timeout = 220s + queue wait —
// previously 120 did not cover the real LLM time and in a hosted deployment the function was killed mid-run.
export const maxDuration = 300;

/**
 * Execute the next pending stage in the mission (one step per call):
 * - The output is saved to the DB as soon as the stage finishes → restart/disconnect loses nothing
 * - The client shows real progress and keeps calling until allDone
 * - Automatically resumes from the stopping point (resumable by design)
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  // >0 like all the siblings — previously negative identifiers leaked through
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  }
  try {
    const result = await runNextAutopilotPhase(numId);
    return NextResponse.json({
      done: result.done,
      allDone: result.allDone,
      executed: result.executed,
      failure: result.failure,
      stepsDone: result.stepsDone,
      totalPhases: result.totalPhases,
      autopilot: result.state,
    });
  } catch (e) {
    if (e instanceof AutopilotError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    // Sanitization — previously a raw e.message leaked to the client
    console.error("[mission:autopilot:step] failed", e);
    return NextResponse.json({ error: "Stage execution failed" }, { status: 500 });
  }
}
