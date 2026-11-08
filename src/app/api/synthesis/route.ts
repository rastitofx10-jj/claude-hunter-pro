import { NextRequest, NextResponse } from "next/server";
import { generateBattleSynthesis, IntelError } from "@/lib/ai-intel";
import type { WatchItem } from "@/lib/hunter-types";

export const dynamic = "force-dynamic";
// worst-case: 2 attempts × 110s through the serial LLM queue — בעבר לא הוגדר בכלל
export const maxDuration = 120;

// POST /api/synthesis — סינתזת קרב חוצת-ריפואים מרשימת המעקב
export async function POST(req: NextRequest) {
  let body: { items?: WatchItem[] };
  try {
    body = (await req.json()) as { items?: WatchItem[] };
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }

  // ולידציה מלאה לפני הפרומפט: בעבר שדות לא-מספריים זרמו לפרומפט כ"ציון undefined/100"
  const items = (body.items ?? []).filter(
    (i) =>
      i &&
      typeof i.fullName === "string" &&
      i.fullName.includes("/") &&
      (i.score === undefined || typeof i.score === "number") &&
      (i.stars === undefined || typeof i.stars === "number")
  );
  if (items.length < 2) {
    return NextResponse.json(
      { error: "סינתזת קרב דורשת לפחות 2 מאגרים ברשימת המעקב — שמור עוד יעדים ואז הפעל" },
      { status: 400 }
    );
  }
  if (items.length > 20) {
    return NextResponse.json({ error: "מותרות עד 20 מאגרים לסינתזה אחת" }, { status: 400 });
  }

  try {
    const synthesis = await generateBattleSynthesis(items);
    return NextResponse.json(synthesis);
  } catch (e) {
    if (e instanceof IntelError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("synthesis failed", e);
    return NextResponse.json({ error: "יצירת סינתזת הקרב נכשלה. נסה שוב." }, { status: 500 });
  }
}
