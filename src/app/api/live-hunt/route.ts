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

/** רשימת הצידים האחרונים — או מצב מלא של ציד בודד (?id=N) */
export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  if (idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
    }
    try {
      const row = await db.liveHunt.findUnique({ where: { id } });
      if (!row) return NextResponse.json({ error: "הציד לא נמצא" }, { status: 404 });
      return NextResponse.json({
        hunt: serializeLiveHunt(row),
        stageOrder: LIVE_HUNT_STAGE_ORDER,
        stageTitles: LIVE_HUNT_STAGE_TITLES,
      });
    } catch {
      return NextResponse.json({ error: "טעינת הציד נכשלה" }, { status: 500 });
    }
  }

  try {
    const rows = await db.liveHunt.findMany({ orderBy: { id: "desc" }, take: 12 });
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
      stageOrder: LIVE_HUNT_STAGE_ORDER,
      stageTitles: LIVE_HUNT_STAGE_TITLES,
    });
  } catch {
    return NextResponse.json({ error: "טעינת הצידים נכשלה" }, { status: 500 });
  }
}

/**
 * פעולות:
 *  start — פתיחת ציד חי חדש (מחזיר מצב ריק; הלקוח מדליק "next" שוב ושוב)
 *  next  — הרצת השלב הבא (או צעד הטייס הבא בתוך execute)
 *  retry — ניסיון חוזר על השלב הנוכחי אחרי כשל
 */
export async function POST(req: NextRequest) {
  let body: { action?: unknown; id?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; id?: unknown };
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!["start", "next", "retry"].includes(action)) {
    return NextResponse.json({ error: "פעולה נדרשת: start | next | retry" }, { status: 400 });
  }

  try {
    if (action === "start") {
      const { id } = await startLiveHunt();
      const row = await db.liveHunt.findUnique({ where: { id } });
      // בעבר: row! — אם השורה נמחקה בין היצירה לקריאה, serializeLiveHunt(null) זרק 500 גנרי. עכשיו תשובה מדויקת.
      if (!row) {
        return NextResponse.json({ error: "הציד נמחק במהלך הפתיחה" }, { status: 500 });
      }
      return NextResponse.json({
        hunt: serializeLiveHunt(row),
        stageOrder: LIVE_HUNT_STAGE_ORDER,
        stageTitles: LIVE_HUNT_STAGE_TITLES,
      });
    }

    const id = typeof body.id === "number" ? body.id : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "נדרש מזהה ציד תקין" }, { status: 400 });
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
    return NextResponse.json({ error: "פעולת הציד החי נכשלה" }, { status: 500 });
  }
}
