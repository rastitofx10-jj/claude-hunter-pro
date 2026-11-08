import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rankDnaForGoal, compileMission, buildMissionBundle } from "@/lib/mission-compiler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_GOAL = 2000;
const MAX_CONTEXT = 2000;

/** רשימת משימות + סטטיסטיקת לולאה */
export async function GET() {
  try {
    const missions = await db.mission.findMany({ orderBy: { id: "desc" }, take: 50 });
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
    return NextResponse.json({ items, stats: { totalDna, fieldDna } });
  } catch (e) {
    console.error("[mission:list]", e);
    return NextResponse.json({ error: "טעינת המשימות נכשלה" }, { status: 500 });
  }
}

/** הידור משימה חדשה: מטרה ← אחזור DNA ← תוכנית קרב */
export async function POST(req: NextRequest) {
  let goal = "";
  let context = "";
  try {
    const body = (await req.json()) as { goal?: unknown; context?: unknown };
    goal = typeof body.goal === "string" ? body.goal.trim() : "";
    context = typeof body.context === "string" ? body.context.trim() : "";
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }
  if (goal.length < 8) {
    return NextResponse.json({ error: "תאר את המטרה במשפט אחד לפחות (8+ תווים)" }, { status: 400 });
  }
  if (goal.length > MAX_GOAL) goal = goal.slice(0, MAX_GOAL);
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT);

  try {
    // אחזור חכם: קודם pre-score זול על metadata בלבד (בלי תוכן), ורק אז
    // טוענים content רק למועמדים המובילים — במקום לטעון את כל התוכנים לזיכרון
    // (בעבר: findMany עם content לכל השורות בלי take)
    const metaDna = await db.dnaArtifact.findMany({
      select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true },
      take: 500,
      orderBy: { id: "desc" },
    });
    if (metaDna.length === 0) {
      return NextResponse.json(
        { error: "הספרייה ריקה — כרה קודם DNA מריפו אליטה בלשונית Genesis" },
        { status: 400 }
      );
    }

    const rankedMeta = rankDnaForGoal(
      goal,
      metaDna.map((r) => ({ ...r, content: null })), // pre-score מטא-דאטה בלבד — content נטען רק למובילים
      24
    );
    const topIds = rankedMeta.map((r) => r.row.id);
    const withContent = await db.dnaArtifact.findMany({
      where: { id: { in: topIds } },
      select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true, content: true },
    });
    // שמירה על סדר הדירוג המקורי, ואז דירוג מחדש מלא (כולל content) ל-8 המובילים
    const contentById = new Map(withContent.map((r) => [r.id, r]));
    const orderedTop = topIds.map((id) => contentById.get(id)).filter((r): r is (typeof withContent)[number] => !!r);

    const selected = rankDnaForGoal(goal, orderedTop, 8);
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
      // בעבר חסר בתשובת POST (ה-GET החזיר) — הערך מוכרז בטיפוס הלקוח אבל לא סופק,
      // וההערה ב-GET מבטיחה "אותה צורה בדיוק". עכשיו אמיתי.
      reportHistory: [],
      autopilot: null,
      autopilotAt: null,
      createdAt: saved.createdAt.toISOString(),
      ...compiled,
      bundle: buildMissionBundle(compiled, goal),
    });
  } catch (e) {
    // (בעבר: e.message גולמי מ-Prisma/ZAI דלף ללקוח — עכשיו לוג שרת + הודעה גנרית)
    console.error("[mission:compile]", e);
    const msg = e instanceof Error && e.name === "MissionError" ? e.message : "הידור המשימה נכשל";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
