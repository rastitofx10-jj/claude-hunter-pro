import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildMissionBundle, type CompiledMission } from "@/lib/mission-compiler";
import { isPrismaNotFound, safeJsonParse } from "@/lib/ai-json";
import { parseAutopilotState } from "@/lib/autopilot";

export const dynamic = "force-dynamic";

/**
 * מצב מעבר חוקיים במכונת המצב של המשימה — אפשר להתקדם, לא לחזור אחורה
 * (בעבר: PATCH קיבל כל מעבר, כולל done → compiled).
 */
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  compiled: new Set(["in_progress", "partial", "done", "failed"]),
  in_progress: new Set(["partial", "done", "failed"]),
  partial: new Set(["in_progress", "done", "failed"]),
  failed: new Set(["in_progress", "partial", "done"]),
  done: new Set([]), // סופי — לא חוזרים אחורה
};

const VALID_STATUSES = new Set(Object.keys(ALLOWED_TRANSITIONS));

/** משפחה של נרמול בטוח: כל שדה JSON פגום/לא-מערך מתקפל לברירת מחדל בטוחה במקום להפיל את הכרטיס */
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
 * parsing סלחני לכל שדה בנפרד + בדיקת טיפוס מלאה אחרי כל JSON.parse.
 * (בעבר: JSON.parse על "null" החזיר null והפיל את הבקשה ל-500 לצמיתות,
 * וערכים לא-מערך זלגו ישר ל-UI וקרסו על .length/.map).
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
  // "null"/null/"" → {} — safeJsonParse עלול להחזיר null מ-payload תקין-לכאורה
  const planRaw = safeJsonParse<unknown>(m.plan, {});
  const plan = (planRaw && typeof planRaw === "object" && !Array.isArray(planRaw)
    ? planRaw
    : {}) as { oneLiner?: string; phases?: unknown; skillMdSource?: string };
  const selectedDnaRaw = safeJsonParse<unknown>(m.dnaRefs, []);
  const promptSeqRaw = safeJsonParse<unknown>(m.promptSequence, []);
  const risksRaw = safeJsonParse<unknown>(m.risks, []);
  const criteriaRaw = safeJsonParse<unknown>(m.successCriteria, []);
  const reportRaw = safeJsonParse<unknown>(m.report, null);
  // היסטוריית דיווחים: פורמט חדש = מערך; ישן = אובייקט יחיד. חשיפה ל-UI:
  // report = הדיווח האחרון (תאימות לאחור), reportHistory = הכל
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
    skillMdSource: plan.skillMdSource === "fallback" ? "fallback" : "ai",
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
    // פלט שטוח — אותה צורה בדיוק כמו תשובת ה-POST, כדי שה-UI יציג בשני המקרים באותה קומפוננטה
    ...compiled,
    bundle: buildMissionBundle(compiled, m.goal),
  };
}

/** פרטי משימה מלאים */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    const m = await db.mission.findUnique({ where: { id: numId } });
    if (!m) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
    return NextResponse.json(parseMission(m));
  } catch (e) {
    console.error("[mission:get]", e);
    return NextResponse.json({ error: "טעינת המשימה נכשלה" }, { status: 500 });
  }
}

/** עדכון סטטוס — עם אכיפת מעברים חוקיים (מכונת מצב), P2025 → 404 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  try {
    const body = (await req.json().catch(() => null)) as { status?: unknown } | null;
    if (!body) return NextResponse.json({ error: "גוף בקשה לא תקין" }, { status: 400 });
    // (בעבר: body.status = 123 → TypeError → 500; כעת בדיקת טיפוס מפורשת → 400)
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
    }
    if (!VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: "סטטוס לא תקין" }, { status: 400 });
    }
    const current = await db.mission.findUnique({ where: { id: numId }, select: { status: true } });
    if (!current) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
    // אותו סטטוס = no-op אידמפוטנטי. בעבר הוחזר 409 מובטח ("in_progress → in_progress")
    // בכל לחיצה על "סמן בביצוע" על משימה שכבר בביצוע — לחצן ה-UI נתקע עם טוסט שגיאה.
    if (current.status === status) {
      return NextResponse.json({ id: numId, status });
    }
    if (!ALLOWED_TRANSITIONS[current.status]?.has(status)) {
      return NextResponse.json(
        { error: `מעבר לא חוקי: ${current.status} → ${status}` },
        { status: 409 }
      );
    }
    const m = await db.mission.update({ where: { id: numId }, data: { status } });
    return NextResponse.json({ id: m.id, status: m.status });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
    }
    console.error("[mission:patch]", e);
    return NextResponse.json({ error: "עדכון הסטטוס נכשל" }, { status: 500 });
  }
}

/** מחיקת משימה — delete ישיר, P2025 → 404 (בלי חלון TOCTOU) */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }
  try {
    await db.mission.delete({ where: { id: numId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
    }
    console.error("[mission:delete]", e);
    return NextResponse.json({ error: "מחיקת המשימה נכשלה" }, { status: 500 });
  }
}
