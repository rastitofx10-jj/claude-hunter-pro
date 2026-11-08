// ============================================================
// Singleton ל-SDK ה-AI — מקור יחיד לחיבור + תור גלובלי.
//
// שתי עובדות שדה (נמדדו חי, 2026-11-09):
// 1. ה-endpoint של ה-AI מקבל קריאה אחת בכל פעם — גם 2 מקבילות מחזירות
//    429 "Too many requests" לאחת מהן. לפני התור: כימרה בזמן סריקה,
//    או דוח משימה בזמן autopilot, נפלו עם שגיאה גולמית ללא retry.
// 2. קריאה רציפה מיד אחרי 429 עוברת — זו מגבלת מקביליות, לא מכסה.
//
// לכן: כל קריאות ה-AI בתהליך עוברות דרך תור טורי (מקביליות 1) עם
// retry עדין ל-429. הטיימאאוט של הקריאה מתחיל רק כשהיא יוצאת מהתור —
// המתנה בתור (למשל אחרי להקה שלמה) לא אוכלת מהזמן המוקצה.
// צד שרת בלבד.
// ============================================================

import ZAI from "z-ai-web-dev-sdk";
import { markTimeoutError, type ErrorFactory } from "./ai-json";

let cached: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null;

export function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  if (!cached) {
    cached = ZAI.create().catch((e) => {
      // איפוס המטמון בכישלון — הקריאה הבאה תנסה ליצור מחדש
      cached = null;
      throw e;
    });
  }
  return cached;
}

// ---------- תור טורי גלובלי לקריאות AI ----------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let queueTail: Promise<unknown> = Promise.resolve();

function is429(e: unknown): boolean {
  return e instanceof Error && /\b429\b|too many requests/i.test(e.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));



/**
 * קריאת AI יחידה דרך התור הגלובלי. מקביליות 1 בתהליך + retry 429
 * (1.5s ואז 3s) — מעלה את אמינות כל המנועים גם כששניים פועלים
 * במקביל מבקשות HTTP שונות. מחזיר את תוכן התשובה (string, ייתכן ריק).
 */
export async function llmComplete(
  messages: LlmMessage[],
  opts?: { timeoutMs?: number; timeoutLabel?: string; timeoutError?: ErrorFactory }
): Promise<{ content: string }> {
  const run = async (): Promise<{ content: string }> => {
    const zai = await getZai();
    const timeoutMs = opts?.timeoutMs ?? 110_000;
    const label = opts?.timeoutLabel ?? "קריאת ה-AI";
    const Err: ErrorFactory = opts?.timeoutError ?? Error;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // טיימאאוט לכל ניסיון בנפרד — ה-SDK לא תומך signal, אז race מקומי.
        // הדגלה כפסק-זמן דרך markTimeoutError שומרת על isTimeoutError()
        // בכל שכבות העל (retry לא מיותר על פסק-זמן).
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages,
            thinking: { type: "disabled" },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(markTimeoutError(new Err(`פסק זמן ${label}`))), timeoutMs);
          }),
        ]);
        return { content: (completion?.choices?.[0]?.message?.content as string | undefined) ?? "" };
      } catch (e) {
        lastErr = e;
        if (is429(e) && attempt < 2) {
          await sleep(attempt === 0 ? 1_500 : 3_000);
          continue;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("קריאת AI נכשלה");
  };

  // שרשור לתור: הקריאה מתחילה רק אחרי שכל הקודמות הסתיימו (הצלחה/כישלון כאחד)
  const job = queueTail.then(run, run);
  // מנע תליית התור על דחייה לא-מטופלת — השגיאה זורמת למי שמחכה ל-job
  queueTail = job.catch(() => undefined);
  return job;
}
