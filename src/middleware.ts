import { NextRequest, NextResponse } from "next/server";

/**
 * הגנת same-origin על בקשות שינוי (POST/PUT/PATCH/DELETE) ל-API.
 *
 * למה: לאפליקציה אין מערכת התחברות — ה-PAT של GitHub שמור בצד השרת ומשמש
 * אוטומטית את כל נתיבי ה-API. בלי שכבת הגנה הזו, כל אתר זדוני שאליו נחשף
 * בעל הכלי יכול לשלוח בקשות cross-origin מהדפדפן שלו (CSRF) ולהריץ ציד/כרייה
 * על חשבון מכסת ה-API של ה-PAT — ואפילו למחוק את הטוקן השמור.
 *
 * איך: דפדפן שולח תמיד כותרת Origin בבקשות שינוי. אם Origin קיים ואינו
 * תואם את ה-Host — חסימה מיידית. בקשות בלי Origin (curl/סקריפטים/כלים
 * server-side) אינן נושאות סיכון CSRF וממשיכות כרגיל, כדי שאוטומציה חיצונית
 * וזרימת העבודה הקיימת לא יישברו.
 */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest) {
  if (!MUTATION_METHODS.has(req.method)) return NextResponse.next();

  const origin = req.headers.get("origin");
  if (!origin) return NextResponse.next(); // לקוח לא-דפדפנאי — אין סיכון CSRF

  const host = req.headers.get("host");
  try {
    if (host && new URL(origin).host === host) return NextResponse.next();
  } catch {
    // Origin משובש — מתייחסים אליו כעוין
  }
  return NextResponse.json(
    { error: "חסימת Cross-Origin: בקשות שינוי מותרות מאותו מקור בלבד" },
    { status: 403 }
  );
}

export const config = {
  matcher: "/api/:path*",
};
