import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * ספריית ה-DNA — מקובץ לפי ריפו.
 * ברירת מחדל קלה: בלי תוכן מלא (ראינו 692KB JSON לכל פתיחת לשונית) —
 * contentPreview לתצוגה + size למיון. תוכן מלא: ?full=1 או /api/dna-library/[id].
 */
const PREVIEW_CHARS = 400;

/**
 * מצב ברירת המחדל (בלי full) — בעבר: findMany עם content מלא מה-DB
 * ואז content=null וניפוח preview בצד השרת — מגה-בייטים מועברים מ-SQLite
 * רק כדי להיזרק. עכשיו: substr בתוך ה-SQL — מהתהליך יוצא רק ה-400 תווים.
 */
async function listLight() {
  const rows = await db.$queryRaw<{
    id: number;
    sourceRepo: string;
    path: string;
    kind: string;
    name: string;
    description: string | null;
    rawUrl: string | null;
    size: number;
    contentPreview: string | null;
    contentLength: number;
  }[]>`
    SELECT id, sourceRepo, path, kind, name, description, rawUrl, size,
           substr(content, 1, ${PREVIEW_CHARS}) AS contentPreview,
           length(content) AS contentLength
    FROM DnaArtifact
    ORDER BY sourceRepo ASC, kind ASC, name ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    sourceRepo: r.sourceRepo,
    path: r.path,
    kind: r.kind,
    name: r.name,
    description: r.description,
    rawUrl: r.rawUrl,
    size: r.size,
    content: null,
    contentPreview: r.contentPreview ?? "",
    hasContent: (r.contentLength ?? 0) > 0,
  }));
}

export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get("full") === "1";
  try {
    if (!full) {
      const items = await listLight();
      return NextResponse.json({ items, full: false });
    }
    // take מפורש — בעבר full=1 החזיר את כל הספרייה בלי גבול
    const rows = await db.dnaArtifact.findMany({
      orderBy: [{ sourceRepo: "asc" }, { kind: "asc" }, { name: "asc" }],
      take: 400,
    });
    return NextResponse.json({ items: rows, full: true });
  } catch (e) {
    console.error("dna-library GET failed", e);
    return NextResponse.json({ error: "טעינת ספריית ה-DNA נכשלה" }, { status: 500 });
  }
}

/**
 * מחיקה: ?repo=owner/name לריפו בודד, או ?all=1 לכל הספרייה.
 * בעבר: מחיקה בלי פרמטר = מחיקת הכל, וגם ?repo= ריק דלף לשם — שגיאת קלד
 * בלתי-הפיכה (אסון נתונים מחכה לקרות). עכשיו: כל פעולה חייבת להיות מפורשת.
 */
export async function DELETE(req: NextRequest) {
  const repo = (req.nextUrl.searchParams.get("repo") ?? "").trim();
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (!repo && !all) {
    return NextResponse.json(
      { error: "נדרש ?repo=owner/name או ?all=1 מפורש — מחיקה בלי הוראה ברורה נחסמת" },
      { status: 400 }
    );
  }
  try {
    await db.dnaArtifact.deleteMany(repo ? { where: { sourceRepo: repo } } : undefined);
    return NextResponse.json({ ok: true, scope: repo || "all" });
  } catch (e) {
    console.error("dna-library DELETE failed", e);
    return NextResponse.json({ error: "המחיקה נכשלה" }, { status: 500 });
  }
}
