import { NextRequest, NextResponse } from "next/server";
import { ghFetch, GhError } from "@/lib/github";
import { clearStoredToken, looksLikeToken, persistToken, storedTokenInfo } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** סטטוס הטוקן השמור בשרת — מוסכם, בלי חשיפה */
export async function GET() {
  const info = await storedTokenInfo();
  return NextResponse.json(info);
}

/** שמירה + אימות מול GitHub לפני קבלה */
export async function POST(req: NextRequest) {
  let token = "";
  try {
    const body = (await req.json()) as { token?: string };
    token = (body.token ?? "").trim();
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }
  if (!looksLikeToken(token)) {
    return NextResponse.json(
      { error: "מבנה טוקן לא מזוהה — צפה לקבל github_pat_... או ghp_..." },
      { status: 400 }
    );
  }
  // אימות אמיתי מול GitHub
  try {
    await ghFetch("/rate_limit", token);
  } catch (e) {
    // 401/403 = הטוקן באמת נדחה. כל דבר אחר (רשת/שעה עמוסה/חוֹ"ל) אינו אשמת
    // הטוקן — בעבר כל כשל מופה ל-401 "הטוקן נדחה" והטעה את המשתמש.
    if (e instanceof GhError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({ error: `הטוקן נדחה: ${e.message}` }, { status: 401 });
    }
    console.error("settings/token POST verification failed", e);
    return NextResponse.json({ error: "האימות מול GitHub נכשל (שגיאת רשת — לא בעיית טוקן)" }, { status: 502 });
  }
  const ok = await persistToken(token);
  if (!ok) return NextResponse.json({ error: "השמירה בשרת נכשלה" }, { status: 500 });
  const info = await storedTokenInfo();
  return NextResponse.json({ ok: true, ...info });
}

/** הסרת הטוקן השמור */
export async function DELETE() {
  await clearStoredToken();
  return NextResponse.json({ ok: true });
}
