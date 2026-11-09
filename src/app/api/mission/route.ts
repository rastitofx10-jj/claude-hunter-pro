import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { selectDnaForGoal, compileMission, buildMissionBundle } from "@/lib/mission-compiler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_GOAL = 2000;
const MAX_CONTEXT = 2000;

/** Mission list + loop statistics */
export async function GET() {
  try {
    // take 50 for display + the real total — previously the header showed only items.length
    // and mission #51 and beyond vanished from the interface without anyone knowing.
    const [missions, total] = await Promise.all([
      db.mission.findMany({ orderBy: { id: "desc" }, take: 50 }),
      db.mission.count(),
    ]);
    const [totalDna, fieldDna] = await Promise.all([
      db.dnaArtifact.count(),
      db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
    ]);
    const items = missions.map((m) => {
      let oneLiner = "";
      let phaseCount = 0;
      let promptCount = 0;
      try {
        const planRaw: unknown = JSON.parse(m.plan);
        const plan = planRaw && typeof planRaw === "object" && !Array.isArray(planRaw)
          ? (planRaw as { oneLiner?: unknown; phases?: unknown })
          : {};
        oneLiner = typeof plan.oneLiner === "string" ? plan.oneLiner : "";
        phaseCount = Array.isArray(plan.phases) ? plan.phases.length : 0;
        const seqRaw: unknown = m.promptSequence ? JSON.parse(m.promptSequence) : [];
        promptCount = Array.isArray(seqRaw) ? seqRaw.length : 0;
      } catch (parseErr) {
        // plan corruption tolerated in list view — but logged, not silent
        console.error("[mission:list] corrupt JSON in mission", m.id, parseErr);
      }
      return {
        id: m.id,
        missionName: m.missionName,
        goal: m.goal,
        status: m.status,
        oneLiner,
        phaseCount,
        promptCount,
        hasReport: !!m.report,
        createdAt: m.createdAt,
      };
    });
    return NextResponse.json({ items, total, stats: { totalDna, fieldDna } });
  } catch (e) {
    console.error("[mission:list]", e);
    return NextResponse.json({ error: "Failed to load the missions" }, { status: 500 });
  }
}

/** Compile a new mission: goal ← DNA retrieval ← battle plan */
export async function POST(req: NextRequest) {
  let goal = "";
  let context = "";
  try {
    const body = (await req.json()) as { goal?: unknown; context?: unknown };
    goal = typeof body.goal === "string" ? body.goal.trim() : "";
    context = typeof body.context === "string" ? body.context.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (goal.length < 8) {
    return NextResponse.json({ error: "Describe the goal in at least one sentence (8+ characters)" }, { status: 400 });
  }
  if (goal.length > MAX_GOAL) goal = goal.slice(0, MAX_GOAL);
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT);

  try {
    // One DNA-selection path for the whole system (selectDnaForGoal in mission-compiler): a cheap
    // metadata-only pre-rank over the newest 500 → full content (truncated to 4,000 chars) only for
    // the leaders → final re-rank. (Before: this route ran its own findMany-based selection while
    // live-hunt's compile stage ranked with raw SQL over the whole library — two paths that could
    // silently pick different genes for the same goal.)
    const selected = await selectDnaForGoal(goal, 8);
    if (selected.length === 0) {
      return NextResponse.json(
        { error: "The DNA library is empty — first mine DNA from an elite repo in the Genesis tab" },
        { status: 400 }
      );
    }

    const compiled = await compileMission(goal, context, selected);

    const saved = await db.mission.create({
      data: {
        goal,
        context: context || null,
        missionName: compiled.missionName,
        status: "compiled",
        plan: JSON.stringify({ oneLiner: compiled.oneLiner, phases: compiled.phases, skillMdSource: compiled.skillMdSource }),
        dnaRefs: JSON.stringify(
          compiled.selectedDna.map((d) => ({ id: d.id, path: d.path, name: d.name, kind: d.kind, sourceRepo: d.sourceRepo }))
        ),
        promptSequence: JSON.stringify(compiled.promptSequence),
        skillMd: compiled.skillMd,
        risks: JSON.stringify(compiled.risks),
        successCriteria: JSON.stringify(compiled.successCriteria),
      },
    });

    return NextResponse.json({
      id: saved.id,
      goal,
      context: context || null,
      status: saved.status,
      report: null,
      // Previously missing from the POST response (the GET returned it) — the value is declared in the
      // client type but was not provided, and the GET comment promises "exactly the same shape". Now real.
      reportHistory: [],
      autopilot: null,
      autopilotAt: null,
      createdAt: saved.createdAt.toISOString(),
      ...compiled,
      bundle: buildMissionBundle(compiled, goal),
    });
  } catch (e) {
    // (Previously: a raw e.message from Prisma/ZAI leaked to the client — now: server log + generic message)
    console.error("[mission:compile]", e);
    const msg = e instanceof Error && e.name === "MissionError" ? e.message : "Mission compilation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
