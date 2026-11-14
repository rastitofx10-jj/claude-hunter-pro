import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildMissionBundle, type CompiledMission } from "@/lib/mission-compiler";
import { isPrismaNotFound, safeJsonParse } from "@/lib/ai-json";
import { parseAutopilotState } from "@/lib/autopilot";

export const dynamic = "force-dynamic";

/**
 * Valid state transitions in the mission state machine — you can move forward, not backward
 * (previously: PATCH accepted any transition, including done → compiled).
 */
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  compiled: new Set(["in_progress", "partial", "done", "failed"]),
  in_progress: new Set(["partial", "done", "failed"]),
  partial: new Set(["in_progress", "done", "failed"]),
  failed: new Set(["in_progress", "partial", "done"]),
  done: new Set([]), // final — no going back
};

const VALID_STATUSES = new Set(Object.keys(ALLOWED_TRANSITIONS));

/** A family of safe normalization: any broken/non-array JSON field collapses to a safe default instead of taking down the card */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function parsePhasesSafe(raw: unknown): CompiledMission["phases"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      ...p,
      steps: Array.isArray(p.steps) ? p.steps.filter((s) => typeof s === "string") : [],
    })) as unknown as CompiledMission["phases"];
}

/**
 * Lenient parsing for each field separately + a full type check after every JSON.parse.
 * (Previously: JSON.parse on "null" returned null and permanently failed the request with a 500,
 * and non-array values leaked straight into the UI and crashed on .length/.map).
 */
function parseMission(m: {
  id: number;
  goal: string;
  context: string | null;
  status: string;
  missionName: string;
  plan: string;
  dnaRefs: string | null;
  promptSequence: string | null;
  skillMd: string | null;
  risks: string | null;
  successCriteria: string | null;
  report: string | null;
  autopilot: string | null;
  autopilotAt: Date | null;
  createdAt: Date;
}) {
  // "null"/null/"" → {} — safeJsonParse can return null from a seemingly valid payload
  const planRaw = safeJsonParse<unknown>(m.plan, {});
  const plan = (planRaw && typeof planRaw === "object" && !Array.isArray(planRaw)
    ? planRaw
    : {}) as { oneLiner?: string; phases?: unknown; skillMdSource?: string };
  const selectedDnaRaw = safeJsonParse<unknown>(m.dnaRefs, []);
  const promptSeqRaw = safeJsonParse<unknown>(m.promptSequence, []);
  const risksRaw = safeJsonParse<unknown>(m.risks, []);
  const criteriaRaw = safeJsonParse<unknown>(m.successCriteria, []);
  const reportRaw = safeJsonParse<unknown>(m.report, null);
  // Report history: new format = array; old = single object. Exposure to the UI:
  // report = the latest report (backward compatibility), reportHistory = everything
  let report: Record<string, unknown> | null = null;
  let reportHistory: Record<string, unknown>[] = [];
  if (Array.isArray(reportRaw)) {
    const list = reportRaw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    reportHistory = list;
    report = list.length ? list[list.length - 1] : null;
  } else if (reportRaw && typeof reportRaw === "object") {
    report = reportRaw as Record<string, unknown>;
    reportHistory = [report];
  }
  const autopilot = m.autopilot ? parseAutopilotState(m.autopilot) : null;

  const compiled: CompiledMission = {
    missionName: m.missionName,
    oneLiner: typeof plan.oneLiner === "string" ? plan.oneLiner : "",
    phases: parsePhasesSafe(plan.phases),
    promptSequence: arr(promptSeqRaw),
    skillMd: typeof m.skillMd === "string" ? m.skillMd : "",
    skillMdSource:
      plan.skillMdSource === "ai" ? "ai" : plan.skillMdSource === "fallback" ? "fallback" : "unknown",
    // (Previously: any value other than fallback was marked "ai" — rows compiled before the tagging era
    // were shown as "AI-generated" even when unknown. Now: an honest "unknown".)
    risks: arr<string>(risksRaw),
    successCriteria: arr<string>(criteriaRaw),
    selectedDna: arr(selectedDnaRaw),
    compiledAt: m.createdAt.toISOString(),
  };

  return {
    id: m.id,
    goal: m.goal,
    context: m.context,
    status: m.status,
    report,
    reportHistory,
    autopilot,
    autopilotAt: m.autopilotAt ? m.autopilotAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    // Flat output — exactly the same shape as the POST response, so the UI renders both cases with the same component
    ...compiled,
    bundle: buildMissionBundle(compiled, m.goal),
  };
}

/** Full mission details */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  }
  try {
    const m = await db.mission.findUnique({ where: { id: numId } });
    if (!m) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    return NextResponse.json(parseMission(m));
  } catch (e) {
    console.error("[mission:get]", e);
    return NextResponse.json({ error: "Failed to load the mission" }, { status: 500 });
  }
}

/** Status update — with enforcement of legal transitions (state machine), P2025 → 404 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  try {
    const body = (await req.json().catch(() => null)) as { status?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    // (Previously: body.status = 123 → TypeError → 500; now: an explicit type check → 400)
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
    }
    if (!VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const current = await db.mission.findUnique({ where: { id: numId }, select: { status: true } });
    if (!current) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    // Same status = an idempotent no-op. Previously a guaranteed 409 was returned ("in_progress → in_progress")
    // on every click of "mark in progress" for a mission already in progress — the UI button got stuck with an error toast.
    if (current.status === status) {
      return NextResponse.json({ id: numId, status });
    }
    if (!ALLOWED_TRANSITIONS[current.status]?.has(status)) {
      return NextResponse.json(
        { error: `Illegal transition: ${current.status} → ${status}` },
        { status: 409 }
      );
    }
    // TOCTOU closed: the update is conditioned on the status that was read — if someone (PATCH/report/step)
    // changed it in the meantime, count=0 and a 409 is returned. Previously: two parallel PATCH calls both
    // validated against the old value and both succeeded — last write wins, including complex illegal transitions.
    const res = await db.mission.updateMany({
      where: { id: numId, status: current.status },
      data: { status },
    });
    if (res.count === 0) {
      return NextResponse.json(
        { error: "The state changed in the meantime — refresh and try again" },
        { status: 409 }
      );
    }
    return NextResponse.json({ id: numId, status });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    }
    console.error("[mission:patch]", e);
    return NextResponse.json({ error: "Status update failed" }, { status: 500 });
  }
}

/** Mission deletion — in a transaction: first the DNA born from it (field:mission-<id>), then the mission.
 * Previously: the DNA born from the mission survived the deletion forever — still ranked in compilations
 * (a +2 boost per source) and "passed on" lessons to the library from a mission that no longer exists. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
  }
  try {
    await db.$transaction(async (tx) => {
      const removed = await tx.dnaArtifact.deleteMany({
        where: { sourceRepo: `field:mission-${numId}` },
      });
      await tx.mission.delete({ where: { id: numId } });
      return removed;
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    }
    console.error("[mission:delete]", e);
    return NextResponse.json({ error: "Mission deletion failed" }, { status: 500 });
  }
}
