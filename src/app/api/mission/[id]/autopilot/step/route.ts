import { NextRequest, NextResponse } from "next/server";
import { runNextAutopilotPhase, AutopilotError } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * ביצוע השלב הבא הממתין במשימה (צעד אחד לכל קריאה):
 * - התוצר נשמר ב-DB מיד עם סיום השלב → ריסטרט/ניתוק לא מאבד כלום
 * - הלקוח מציג התקדמות אמיתית וממשיך לקרוא עד allDone
 * - חוזר אוטומטית מנקודת העצירה (resumable by design)
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  // >0 כמו בכל האחים — בעבר מזהים שליליים דלפו פנימה
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
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
    // סניטציה — בעבר e.message גולמי דלף ללקוח
    console.error("[mission:autopilot:step] failed", e);
    return NextResponse.json({ error: "ביצוע השלב נכשל" }, { status: 500 });
  }
}
