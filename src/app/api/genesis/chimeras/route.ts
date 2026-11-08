import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** היסטוריית כימרות שנוצרו.
 * מחזיר את אותה צורה בדיוק כמו POST /api/genesis/synthesize
 * (chimeraName/oneLiner/generatedAt) — בעבר: שדות שונים (name/createdAt) וה-UI
 * הציג כותרות ריקות והוריד genesis-undefined.md על לחיצה בהיסטוריה. */
export async function GET() {
  try {
    const rows = await db.chimera.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        // שמות השדות שה-UI מצפה להם (ChimeraResponse)
        chimeraName: r.name,
        // הערך האמיתי שנשמר ביצירה; breakthrough רק כגיבוי לשורות ישנות
        // (בעבר: oneLiner זויף מתוך breakthrough — הכותרת שה-AI כתב אבדה).
        oneLiner: r.oneLiner ?? r.breakthrough ?? "",
        skillMd: r.skillMd,
        principles: safeArr(r.principles),
        workOrders: safeArr(r.workOrders),
        breakthrough: r.breakthrough,
        sources: r.sources.split(",").filter(Boolean),
        generatedAt: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[genesis:chimeras]", e);
    return NextResponse.json({ error: "טעינת הכימרות נכשלה" }, { status: 500 });
  }
}

function safeArr(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
