import { NextRequest, NextResponse } from "next/server";
import { generateRepoIntel, IntelError } from "@/lib/ai-intel";
import type { AnalyzeResponse } from "@/lib/hunter-types";

export const dynamic = "force-dynamic";
// worst-case: 2 attempts × 110s through the serial LLM queue — בעבר לא הוגדר בכלל
// ובפריסה hosted הפונקציה נהרגה באמצע קריאת ה-AI (genesis מגדיר 120; כאן אותו חוק).
export const maxDuration = 120;

// POST /api/intel — דוח מודיעין AI עבור תוצאת ניתוח שכבר בוצעה
export async function POST(req: NextRequest) {
  let body: AnalyzeResponse;
  try {
    body = (await req.json()) as AnalyzeResponse;
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }

  if (!body?.repo?.fullName || typeof body?.score?.total !== "number") {
    return NextResponse.json(
      { error: "נדרשת תוצאת ניתוח תקינה — נתח את המאגר קודם ואז הפעל את דוח המודיעין" },
      { status: 400 }
    );
  }
  // הגנה על הפרומפט: גוף ללא models/evidence תקינים זרם "undefined" לפרומפט
  // והפיל 500 גנרי בתוך generateRepoIntel (בעבר: הפרומפט קיבל "undefined/100" וכד')
  if (body.models !== undefined && !Array.isArray(body.models)) {
    return NextResponse.json({ error: "שדה models חייב להיות מערך" }, { status: 400 });
  }
  if (body.evidence !== undefined && !Array.isArray(body.evidence)) {
    return NextResponse.json({ error: "שדה evidence חייב להיות מערך" }, { status: 400 });
  }

  try {
    const intel = await generateRepoIntel(body);
    return NextResponse.json(intel);
  } catch (e) {
    if (e instanceof IntelError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("intel failed", e);
    return NextResponse.json({ error: "יצירת דוח המודיעין נכשלה. נסה שוב." }, { status: 500 });
  }
}
