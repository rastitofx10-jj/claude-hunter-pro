import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  startLiveHunt,
  runNextLiveHuntStage,
  retryLiveHunt,
  serializeLiveHunt,
  LiveHuntError,
  LIVE_HUNT_STAGE_ORDER,
  LIVE_HUNT_STAGE_TITLES,
} from "@/lib/live-hunt";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** List of recent hunts — or the full state of a single hunt (?id=N) */
export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  if (idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Invalid identifier" }, { status: 400 });
    }
    try {
      const row = await db.liveHunt.findUnique({ where: { id } });
      if (!row) return NextResponse.json({ error: "Hunt not found" }, { status: 404 });
      return NextResponse.json({
        hunt: serializeLiveHunt(row),
        stageOrder: LIVE_HUNT_STAGE_ORDER,
        stageTitles: LIVE_HUNT_STAGE_TITLES,
      });
    } catch {
      return NextResponse.json({ error: "Failed to load the hunt" }, { status: 500 });
    }
  }

  try {
    // take 12 for display + the real total (mirrors /api/mission) — the Overview
    // KPI used items.length and silently capped at 12 once the history grew,
    // so hunt #13 and beyond vanished from the dashboard's count.
    const [rows, total] = await Promise.all([
      db.liveHunt.findMany({ orderBy: { id: "desc" }, take: 12 }),
      db.liveHunt.count(),
    ]);
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        stageKey: r.stageKey,
        goal: r.goal.slice(0, 160),
        missionId: r.missionId,
        generation: r.generation,
        seededFrom: r.seededFrom,
        dnaBefore: r.dnaBefore,
        dnaAfter: r.dnaAfter,
        llmCalls: r.llmCalls,
        elapsedMs: r.elapsedMs,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
        stagesCount: (() => {
          try {
            return (JSON.parse(r.stages ?? "[]") as unknown[]).length;
          } catch {
            return 0;
          }
        })(),
      })),
      total,
      stageOrder: LIVE_HUNT_STAGE_ORDER,
      stageTitles: LIVE_HUNT_STAGE_TITLES,
    });
  } catch {
    return NextResponse.json({ error: "Failed to load the hunts" }, { status: 500 });
  }
}

/**
 * Actions:
 *  start — open a new live hunt (returns an empty state; the client fires "next" again and again)
 *  next  — run the next stage (or the next pilot step within execute)
 *  retry — retry the current stage after a failure
 */
export async function POST(req: NextRequest) {
  let body: { action?: unknown; id?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; id?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!["start", "next", "retry"].includes(action)) {
    return NextResponse.json({ error: "Action required: start | next | retry" }, { status: 400 });
  }

  try {
    if (action === "start") {
      const { id } = await startLiveHunt();
      const row = await db.liveHunt.findUnique({ where: { id } });
      // Previously: row! — if the row was deleted between creation and read, serializeLiveHunt(null) threw a generic 500. Now: a precise response.
      if (!row) {
        return NextResponse.json({ error: "The hunt was deleted during startup" }, { status: 500 });
      }
      return NextResponse.json({
        hunt: serializeLiveHunt(row),
        stageOrder: LIVE_HUNT_STAGE_ORDER,
        stageTitles: LIVE_HUNT_STAGE_TITLES,
      });
    }

    const id = typeof body.id === "number" ? body.id : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "A valid hunt identifier is required" }, { status: 400 });
    }

    if (action === "retry") {
      const state = await retryLiveHunt(id);
      return NextResponse.json({
        hunt: state,
        stageOrder: LIVE_HUNT_STAGE_ORDER,
        stageTitles: LIVE_HUNT_STAGE_TITLES,
      });
    }

    // action === "next"
    const state = await runNextLiveHuntStage(id);
    return NextResponse.json({
      hunt: state,
      stageOrder: LIVE_HUNT_STAGE_ORDER,
      stageTitles: LIVE_HUNT_STAGE_TITLES,
    });
  } catch (e) {
    if (e instanceof LiveHuntError) {
      const payload: Record<string, unknown> = { error: e.message };
      const state = (e as LiveHuntError & { state?: unknown }).state;
      if (state) payload.hunt = state;
      return NextResponse.json(payload, { status: e.status });
    }
    console.error("[live-hunt]", e);
    return NextResponse.json({ error: "The live hunt operation failed" }, { status: 500 });
  }
}
