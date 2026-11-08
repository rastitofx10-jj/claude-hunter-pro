import { NextRequest, NextResponse } from "next/server";
import { harvest } from "@/lib/harvester";
import { GhError } from "@/lib/github";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** נעילת קציר: קציר הוא צינור ארוך (עד 300 שניות) — שני POST מקביליים
 * היו מכפילים שריפת מכסה ומנים במקביל את אותם ריפו (בעבר: בלי שום נעילה) */
let harvestRunning = false;

/** קציר אוטונומי: גילוי מאגרי אליטה 5.5+ ← כריית DNA ← הספרייה מתפוצצת */
export async function POST(req: NextRequest) {
  if (harvestRunning) {
    return NextResponse.json({ error: "קציר כבר רץ כרגע — חכה לסיומו" }, { status: 409 });
  }
  harvestRunning = true;
  let maxRepos = 6;
  try {
    const body = (await req.json()) as { maxRepos?: unknown };
    if (typeof body.maxRepos === "number") {
      maxRepos = Math.max(1, Math.min(10, Math.floor(body.maxRepos)));
    }
  } catch {
    // גוף ריק מותר — ברירת מחדל 6
  }

  try {
    const token = await resolveToken(req);
    const result = await harvest(token, maxRepos);
    await captureTokenFrom(req);
    return NextResponse.json(result);
  } catch (e) {
    // (בעבר: e.message גולמי דלף ללקוח)
    console.error("[harvest]", e);
    // מכסת GitHub שנגמרה — 429 מדויק במקום 500 גנרי שמטעה ("נסה שוב" לא עוזר)
    if (e instanceof GhError && e.rateLimited === true) {
      return NextResponse.json(
        { error: "מכסת GitHub API נגמרה — הקציר נעצר. נסה שוב בעוד דקה." },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: "הקציר האוטונומי נכשל — פרטים בלוג השרת" }, { status: 500 });
  } finally {
    harvestRunning = false;
  }
}
