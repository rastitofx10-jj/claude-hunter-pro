import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runNextAutopilotPhase, AutopilotError, parseAutopilotState } from "@/lib/autopilot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PHASES_PER_RUN = 4;

/**
 * ריצה מלאה (תאימות לאחור): מריצה שלב-אחר-שלב דרך אותו מנוע בדיוק
 * (runNextAutopilotPhase) עם חסם שלבים לריצה בודדת.
 * ההעדפה בממשק היא ריצת-צעד של הלקוח — כאן נשארת ריצה רציפה לשימוש ידני/אוטומציה.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }

  try {
    // שלבים שכבר בוצעו מריצות קודמות — חייבים להיכלל ב-remaining,
    // אחרת משימה בת 6 שלבים עם 2 בוצעים דיווחה remaining: 2 גם כשנשארו 4
    const pre = await db.mission.findUnique({ where: { id: numId }, select: { autopilot: true } });
    const preState = parseAutopilotState(pre?.autopilot ?? null);
    const preDone = preState.steps.length + preState.failures.length;

    const steps: NonNullable<Awaited<ReturnType<typeof runNextAutopilotPhase>>["executed"]>[] = [];
    const failures: { phaseIndex: number; error: string }[] = [];
    let totalPhases = 0;
    let firstRun = true;

    // לולאה על אותו מנוע צעד-צעד — עד שאין עוד שלבים
    for (;;) {
      if (steps.length + failures.length >= MAX_PHASES_PER_RUN) break;
      const r = await runNextAutopilotPhase(numId);
      totalPhases = r.totalPhases;
      if (firstRun && r.done && r.executed === null && r.failure === null) {
        // המשימה כבר בוצעה במלואה — לא שגיאה, פשוט אין מה להריץ
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
      if (!r.executed && !r.failure) break; // תקיעה — לא להיתקע בלולאה
    }

    if (steps.length === 0 && preDone === 0) {
      const detail = failures.map((f) => `שלב ${f.phaseIndex + 1}: ${f.error}`).join(" · ");
      return NextResponse.json(
        { error: `כל השלבים נכשלו${detail ? `: ${detail}` : ""}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      steps,
      failures,
      totalPhases,
      // remaining = שלבים שעדיין לא בוצעו גם מריצות קודמות וגם מזו
      remaining: Math.max(0, totalPhases - (preDone + steps.length + failures.length)),
    });
  } catch (e) {
    if (e instanceof AutopilotError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    // סניטציה — בעבר e.message גולמי (Prisma/רשת) דלף ללקוח
    console.error("[mission:autopilot] failed", e);
    return NextResponse.json({ error: "הריצה האוטונומית נכשלה" }, { status: 500 });
  }
}
