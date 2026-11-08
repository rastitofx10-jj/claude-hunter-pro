// ============================================================
// עזרי JSON-מ-AI משותפים — מקור האמת היחיד לחילוץ, תיקון ונרמול
// של תשובות LLM. כל המודולים (genesis, mission-compiler, ai-intel)
// מחויבים לכאן — אסור לשכפל את ההיגיון הזה שוב.
// ============================================================

export class AiJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiJsonError";
  }
}

export type ErrorFactory = new (message: string) => Error;

const TIMEOUT_FLAG = "__ai_timeout__";

/** האם השגיאה נגרמה מפסק זמן — עליה לא מנסים שוב (אותה תוצאה, בזבוז דקות) */
export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as Record<string, unknown>)[TIMEOUT_FLAG] === true;
}

/** מסמן שגיאה כפסק-זמן — משמש את התור ב-zai.ts כדי שהקריאות בשכבות
 *  העל יזהו פסק-זמן (isTimeoutError) וימנעו retry מיותר */
export function markTimeoutError<T extends Error>(err: T): T {
  (err as unknown as Record<string, unknown>)[TIMEOUT_FLAG] = true;
  return err;
}

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  Err: ErrorFactory = AiJsonError
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      const t = setTimeout(() => {
        const err = new Err(`פסק זמן ${label}`) as Error & Record<string, unknown>;
        err[TIMEOUT_FLAG] = true;
        rej(err);
      }, ms);
      // מנע דליפת timer — שחרור כשההבטחה הראשית מתיישבת
      p.finally(() => clearTimeout(t)).catch(() => undefined);
    }),
  ]);
}

/**
 * מסיר רק גדר קוד שעוטפת את כל הpayload (```json ... ``` בתחילת/סוף) —
 * לא נוגע בגדרות בתוך ערכי ה-JSON עצמם (קטעי קוד לגיטימיים בשדות),
 * שהסרה שלהן הרסה payload תקין (באג קריטי שתוקן).
 */
export function stripFences(raw: string): string {
  let s = raw.trim();
  // גדר פותחת רק בתחילת הpayload: ```json / ```JSON / ```
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n?/, "");
  // גדר סוגרת רק בסוף הpayload
  s = s.replace(/\n?```\s*$/, "");
  return s.trim();
}

/**
 * ל-SKILL.md ושאר מסמכי markdown: מסיר רק גדר עוטפת בלבד —
 * כל הגדרות הקוד הפנימיות (```bash וכו') נשמרות כפי שה-AI כתב אותן.
 */
export function stripOuterFence(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:markdown|md)?\s*\n/i, "");
  s = s.replace(/\n```\s*$/i, "");
  return s.trim();
}

export function repairTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/**
 * תיקון ציטוטים פנימיים עם מעקב מיקום-מפתח:
 * מחרוזת שנפתחת אחרי `{` `,` `[` היא מפתח → `":` סוגרת אותה.
 * מחרוזת שנפתחת אחרי `:` היא ערך → `"` לפני `:` נחשב תוכן פנימי ומבריח
 * (המקרה הפתולוגי `"paste":"do "X": now"`), ואילו סגירה לפני `,` `}` `]` תקפה.
 */
export function escapeInnerQuotes(s: string): string {
  let out = "";
  let inStr = false;
  let backslashes = 0; // רץ-בריחה: ספירת \\ רצופים כדי לא לפגוע ב-\" תקין
  let keyPos = true; // האם המחרוזת הבאה נפתחת במיקום מפתח?
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') {
        inStr = true;
        backslashes = 0;
        out += c;
        continue;
      }
      if (c === ':' || c === '}' || c === ']') {
        keyPos = false;
        out += c;
        continue;
      }
      if (c === ',' || c === '{' || c === '[') {
        keyPos = true;
        out += c;
        continue;
      }
      if (!/\s/.test(c)) keyPos = false; // ערך סקלרי (123/true) — אחריו המחרוזת הבאה אינה מפתח
      out += c;
    } else {
      if (c === '"') {
        const escaped = backslashes % 2 === 1;
        if (escaped) {
          out += c; // \" תקין — נשאר בתוך המחרוזת
          backslashes = 0;
          continue;
        }
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const nxt = s[j];
        if (
          nxt === undefined ||
          nxt === ',' ||
          nxt === '}' ||
          nxt === ']' ||
          (nxt === ':' && keyPos)
        ) {
          inStr = false;
          out += c;
          backslashes = 0;
        } else {
          out += '\\"'; // ציטוט פנימי בתוך ערך — מבריחים
          backslashes = 0;
        }
      } else if (c === '\\') {
        backslashes++;
        out += c;
      } else {
        if (c !== '\n' && c !== '\r') backslashes = 0;
        out += c;
      }
    }
  }
  return out;
}

/**
 * סריקת סוגריים מאוזנים מה-{ הראשון — מוצא את סוף האובייקט האמיתי
 * (lastIndexOf נכשל כשיש פרוזה עם } אחרי ה-JSON), מתעלם מסוגריים בתוך מחרוזות.
 */
function balancedObjectSlice(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(raw: string, Err: ErrorFactory = AiJsonError): Record<string, unknown> {
  const cleaned = stripFences(raw);
  // מערך ברמה העליונה — רק אם `[` מקדים את `{` (מודלים מסוימים מחזירים [...])
  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrEnd > firstArr) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(firstArr, arrEnd + 1));
        if (Array.isArray(parsed)) return { items: parsed };
      } catch {
        // לא מערך תקין — נמשיך לנתיב האובייקט
      }
    }
  }
  if (firstObj === -1) {
    throw new Err("ה-AI לא החזיר JSON — נסה שוב");
  }
  const slice = balancedObjectSlice(cleaned, firstObj) ?? cleaned.slice(firstObj, cleaned.lastIndexOf("}") + 1);
  for (const cand of [
    slice,
    repairTrailingCommas(slice),
    escapeInnerQuotes(slice),
    repairTrailingCommas(escapeInnerQuotes(slice)),
  ]) {
    try {
      const parsed: unknown = JSON.parse(cand);
      if (parsed !== null && !Array.isArray(parsed) && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // next repair level
    }
  }
  throw new Err("ה-AI החזיר JSON שבור — נסה שוב");
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

export function strArr(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * JSON.parse סלחני לנתונים שמורים ב-DB — שדה פגום אחד לא יפיל את כל הבקשה.
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** זיהוי שגיאת Prisma "רשומה לא נמצאה" (P2025) — להבדלת 404 מ-500 אמיתי */
export function isPrismaNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "P2025"
  );
}

/**
 * סניטציה לשמות-קוד שמגיעים מה-AI לפני שהם נכנסים ל-DB או לנתיבים
 * (`.claude/skills/<name>/SKILL.md`): רק a-z 0-9 מקף וקו תחתון.
 * מונע רווחים, תווים עבריים, נטיות נתיב (../) ושמות ריקים.
 */
export function sanitizeSlug(raw: unknown, fallback: string, maxLen = 60): string {
  const s = sanitizeSlugLoose(raw);
  return (s || fallback).slice(0, maxLen);
}

/** גרסה ללא fallback — למקרים שרוצים לבדוק ריקות בעצמם */
function sanitizeSlugLoose(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
