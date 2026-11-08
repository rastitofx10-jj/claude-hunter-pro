import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isPrismaNotFound } from "@/lib/ai-json";

export const dynamic = "force-dynamic";

interface WatchBody {
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description?: string | null;
  stars?: number;
  score?: number;
  models?: string | null;
  evidence?: string | null;
  notes?: string | null;
}

// הגבלות קלט — בעבר ללא תקרית: מחרוזות ארוכות ללא גבול נכנסו ל-DB וזו היתה
// נקודת שחיתות פוטנציאלית (payload גדול מהלקוח לצמיתות ב-DB).
const MAX_TEXT = 1000;
const cap = (v: string | null | undefined, max = MAX_TEXT): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export async function GET() {
  try {
    const items = await db.savedRepo.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return NextResponse.json({ items });
  } catch (e) {
    console.error("watchlist GET failed", e);
    return NextResponse.json({ error: "טעינת הרשימה נכשלה" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as WatchBody;
    if (!b.fullName || !b.owner || !b.name || !b.url) {
      return NextResponse.json({ error: "חסרים שדות חובה (fullName/owner/name/url)" }, { status: 400 });
    }
    // אימות בסיסי של ה-URL — הוא מוצג כ-<a href> ב-UI; בעבר התקבל כל ערך.
    if (!/^https:\/\/github\.com\//.test(b.url)) {
      return NextResponse.json({ error: "url חייב להיות קישור github.com (https)" }, { status: 400 });
    }
    const safe: WatchBody = {
      ...b,
      fullName: b.fullName.slice(0, 200),
      owner: b.owner.slice(0, 120),
      name: b.name.slice(0, 200),
      url: b.url.slice(0, 500),
    };
    // עדכון סלקטיבי אמיתי: שדה שלא נשלח — לא נדרס. וגם: ערך null מפורש לא מוחק
    // נתונים קיימים — בעבר הלקוח שלח models: null (מסלול חיפוש) ומחק בשקט מודלים
    // שנשמרו מהניתוח. רק ערך אמיתי (לא ריק/לא null) מעדכן.
    const item = await db.savedRepo.upsert({
      where: { fullName: safe.fullName },
      update: {
        ...(safe.stars !== undefined ? { stars: safe.stars ?? 0 } : {}),
        ...(safe.score !== undefined ? { score: safe.score ?? 0 } : {}),
        ...(cap(safe.description) !== null ? { description: cap(safe.description) } : {}),
        ...(cap(safe.models, 300) !== null ? { models: cap(safe.models, 300) } : {}),
        ...(cap(safe.evidence) !== null ? { evidence: cap(safe.evidence) } : {}),
        ...(cap(safe.notes) !== null ? { notes: cap(safe.notes) } : {}),
      },
      create: {
        fullName: safe.fullName,
        owner: safe.owner,
        name: safe.name,
        url: safe.url,
        description: cap(safe.description),
        stars: safe.stars ?? 0,
        score: safe.score ?? 0,
        models: cap(safe.models, 300),
        evidence: cap(safe.evidence),
        notes: cap(safe.notes),
      },
    });
    return NextResponse.json({ item });
  } catch (e) {
    console.error("watchlist POST failed", e);
    return NextResponse.json({ error: "השמירה נכשלה" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "נדרש id תקין" }, { status: 400 });
    }
    await db.savedRepo.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P2025 = הרשומה לא נמצאה → 404 אמיתי. כל דבר אחר = 500 עם לוג — בעבר כל שגיאה
    // הוחזרה כ-400 שקרי ובלי לוג.
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "הפריט לא נמצא" }, { status: 404 });
    }
    console.error("watchlist DELETE failed", e);
    return NextResponse.json({ error: "המחיקה נכשלה" }, { status: 500 });
  }
}
