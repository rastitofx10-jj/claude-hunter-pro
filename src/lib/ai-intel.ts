// ============================================================
// מנוע מודיעין AI — Claude Hunter
// סוגר את הלולאה: מ"מציאת פרויקטים" ל"החלטות מוצר".
// פועל בצד שרת בלבד (z-ai-web-dev-sdk אסור בצד לקוח).
// ============================================================

import { extractJson, isTimeoutError, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import type {
  AnalyzeResponse,
  BattleSynthesis,
  BetterMove,
  RepoIntel,
  StealIdea,
  SynthPattern,
  TopMove,
  WatchItem,
} from "./hunter-types";

export class IntelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelError";
  }
}

const TIMEOUT_MS = 110_000;

const SYSTEM_ROLE = `אתה אנליסט מודיעין תחרותי בכיר בצוות מוצר שבונה ממשק AI חדשני.
המשימה שלך: להפוך ראיות גולמיות מ-GitHub לתוכנית קרב מעשית בעברית.

כללי ברזל:
1. אתה מנוע JSON — מחזיר JSON תקין ותו לא מעבר. בלי גדרי קוד (code fences), בלי הסברים, בלי מרקדאון.
2. כל שדה בעברית בלבד (שמות טכניים כמו CLAUDE.md / claude-opus-5-5 נשארים באנגלית בתוך הטקסט).
3. אסור להמציא עובדות שאינן בראיות. אין ראיה למשהו? כתוב שלא נמצאה ראיה או דלג.
4. הסף המחמיר שלנו: רק מודלים בגרסה 5.5 ומעלה (Opus 5.5, Fable, Opus 6+) נחשבים פרימיום. משפחת 4.x כלום.
5. תמיד מנקודת מבט של "מה זה נותן למוצר שלנו" — לא סקירה אקדמית אלא פקודות מבצע.
6. בתוך ערכי מחרוזת ב-JSON אסורה מרכאה כפולה (") — החלף בגרש (') או במירכאות עבריות (״).`;

// ---------- utilities ----------

const EFFORTS = new Set(["נמוך", "בינוני", "גבוה", "לא ידוע"]);

function stealArr(v: unknown, max = 6): StealIdea[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): StealIdea | null => {
      if (typeof x === "string") {
        const what = x.trim();
        return what ? { what, why: "", how: undefined } : null;
      }
      const o = (x ?? {}) as Record<string, unknown>;
      const what = str(o.what ?? o.idea ?? o.title);
      if (!what) return null;
      return { what, why: str(o.why ?? o.reason), how: str(o.how ?? o.implementation) || undefined };
    })
    .filter((x): x is StealIdea => !!x)
    .slice(0, max);
}
function betterArr(v: unknown, max = 6): BetterMove[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): BetterMove | null => {
      const o = (x ?? {}) as Record<string, unknown>;
      const gap = str(o.gap ?? o.weakness ?? o.theyMiss);
      if (!gap) return null;
      return { gap, ourMove: str(o.ourMove ?? o.opportunity ?? o.howWeWin) };
    })
    .filter((x): x is BetterMove => !!x)
    .slice(0, max);
}

function moveArr(v: unknown, max = 7): TopMove[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const move = str(o.move ?? o.action ?? o.title);
      if (!move) return null;
      const eff = str(o.effort, "לא ידוע");
      return { move, why: str(o.why ?? o.reason), effort: (EFFORTS.has(eff) ? eff : "לא ידוע") as TopMove["effort"] };
    })
    .filter((x): x is TopMove => !!x)
    .slice(0, max);
}

function patternArr(v: unknown, max = 6): SynthPattern[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const pattern = str(o.pattern ?? o.title ?? o.theme);
      if (!pattern) return null;
      return { pattern, repos: strArr(o.repos, 12), insight: str(o.insight ?? o.meaning) };
    })
    .filter((x): x is SynthPattern => !!x)
    .slice(0, max);
}

const RETRY_HINT = `\n\n⚠️ תיקון חוזר: התגובה הקודמת שלך לא הייתה JSON תקין.
החזר שוב את אותו הדוח בדיוק, הפעם ב-JSON מהודק:
- אסורות מרכאות כפולות (") בתוך ערכי מחרוזת — גרש (') או מירכאות עבריות (״) בלבד
- אסורים פסיקים תלויים לפני } או ]
- החזר את גוף ה-JSON בלבד, שום טקסט אחר.`;

async function llmJson(userPrompt: string): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // התור הגלובלי ב-zai.ts (מקביליות 1 + retry 429) — ראה תיעוד שם
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: SYSTEM_ROLE },
          { role: "user", content: attempt === 0 ? userPrompt : userPrompt + RETRY_HINT },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "קריאת ה-AI", timeoutError: IntelError }
      );
      if (!raw.trim()) {
        lastErr = new IntelError("ה-AI החזיר תשובה ריקה — נסה שוב");
        continue;
      }
      return extractJson(raw, IntelError);
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — ניסיון חוזר יבזבז עוד 110 שניות
      if (e instanceof IntelError) {
        lastErr = e;
        continue; // parse failure → retry with repair hint
      }
      throw e; // network — no point retrying within same request
    }
  }
  throw lastErr instanceof Error ? lastErr : new IntelError("יצירת הדוח נכשלה");
}

// ---------- digest builders ----------

function repoDigest(a: AnalyzeResponse): string {
  const qual = a.models.filter((m) => m.qualifying);
  const blocked = a.models.filter((m) => !m.qualifying);
  return [
    `מאגר: ${a.repo.fullName}`,
    `תיאור: ${a.repo.description ?? "אין"}`,
    `כוכבים: ${a.repo.stars} · forks: ${a.repo.forks} · תורמים: ${a.contributors} · שפה ראשית: ${a.repo.language ?? "?"}`,
    `ציון השקעה: ${a.score.total}/100 (מודלים ${a.score.modelScore}/45, תשלום ${a.score.paidScore}/30, תנועה ${a.score.tractionScore}/25, שימוש ${a.score.usageScore}/15)`,
    `עומד בסף 5.5+: ${a.score.meetsModelThreshold ? "כן" : "לא"}`,
    qual.length ? `מודלים מזכים (5.5+): ${qual.map((m) => `${m.label}${m.hits ? ` [${m.hits} קבצים]` : ""} (מקורות: ${m.sources.join("/")})`).join("; ")}` : "מודלים מזכים: אף אחד",
    blocked.length ? `מודלים חסומים שנמצאו (4.x ומטה, משקל 0): ${blocked.map((m) => m.label).join(", ")}` : "",
    a.evidence.length ? `ראיות תשלום: ${a.evidence.map((e) => e.label).join("; ")}` : "ראיות תשלום: אין",
    a.commands.length ? `פקודות Claude Code: /${a.commands.join(", /")}` : "",
    a.agents.length ? `סוכני משנה: ${a.agents.join(", ")}` : "",
    a.mcpServers.length ? `שרתי MCP: ${a.mcpServers.join(", ")}` : "",
    a.mentions.prices.length ? `אזכורי מחיר ב-README: ${a.mentions.prices.join(", ")}` : "",
    a.mentions.tokens.length ? `אזכורי טוקנים ב-README: ${a.mentions.tokens.join(", ")}` : "",
    `הצהרת "נבנה עם Claude": ${a.mentions.builtWithClaude ? "כן" : "לא"}`,
    a.claudeFiles.length ? `קבצי Claude: ${a.claudeFiles.slice(0, 20).map((f) => f.path).join(", ")}` : "קבצי Claude: אין",
    a.languages.length ? `שפות: ${a.languages.map((l) => `${l.name} ${l.pct}%`).join(", ")}` : "",
    `קטע README (עד 1800 תווים):\n${(a.readmeExcerpt ?? "").slice(0, 1800) || "אין"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- public API ----------

/** דוח מודיעין AI למאגר בודד — מתוך תוצאת ניתוח קיימת */
export async function generateRepoIntel(a: AnalyzeResponse): Promise<RepoIntel> {
  const prompt = `חבילת ראיות מהסריקה האוטומטית שלנו:

${repoDigest(a)}

בנה דוח מודיעין תחרותי למוצר שלנו (ממשק AI). החזר JSON בדיוק במבנה הבא:
{
  "verdict": "פסק דין אסטרטגי ב-1-2 משפטים: האם ומה כדאי ללמוד מהפרויקט הזה",
  "moneyVerdict": "שיפוט עומק ההשקעה בטוקנים ובמודלים יקרים, עם נימוק קצר המבוסס אך ורק על הראיות",
  "moneyLevel": "אחד מדויק: בטוח | סביר | חלש | לא ידוע",
  "whatTheyBuilt": ["3-5 עובדות על מה הפרויקט עושה, מהראיות בלבד"],
  "brilliant": ["2-5 דברים גאוניים/מתוחכמים בגישה שלהם, או [] אם אין"],
  "stealThis": [{"what": "מה לאמץ לממשק שלנו", "why": "למה זה עובד בשבילם", "how": "איך נממש אצלנו בקווים כלליים"}],
  "doBetter": [{"gap": "חולשה/פער אמיתי שלהם", "ourMove": "איך אנחנו מנצחים שם"}],
  "actionItems": ["3-6 צעדים קונקרטיים ומדידים לספרינט הקרוב שלנו"],
  "riskNotes": ["הסתייגויות: מה הראיות לא מוכיחות, סיכוני העתקה, רישיון וכו'"]
}
אם אין מספיק ראיות לשדה — החזר מערך ריק או "לא ידוע", אל תמציא.`;

  const j = await llmJson(prompt);
  const level = str(j.moneyLevel, "לא ידוע");
  const levels = ["בטוח", "סביר", "חלש", "לא ידוע"] as const;
  return {
    verdict: str(j.verdict, "לא התקבל פסק דין"),
    moneyVerdict: str(j.moneyVerdict),
    moneyLevel: (levels as readonly string[]).includes(level) ? (level as RepoIntel["moneyLevel"]) : "לא ידוע",
    whatTheyBuilt: strArr(j.whatTheyBuilt),
    brilliant: strArr(j.brilliant),
    stealThis: stealArr(j.stealThis),
    doBetter: betterArr(j.doBetter),
    actionItems: strArr(j.actionItems),
    riskNotes: strArr(j.riskNotes),
    generatedAt: new Date().toISOString(),
  };
}

/** סינתזת קרב — מודיעין חוצת-ריפואים מכל רשימת המעקב */
export async function generateBattleSynthesis(items: WatchItem[]): Promise<BattleSynthesis> {
  const list = items
    .slice(0, 20)
    .map((w, i) => {
      const models = (w.models ?? "").split(",").filter(Boolean).join(", ") || "לא זוהו";
      let notes = "";
      if (w.evidence) {
        try {
          const ev = JSON.parse(w.evidence) as { label?: string }[];
          if (Array.isArray(ev)) notes = ev.map((e) => e.label).filter(Boolean).slice(0, 4).join("; ");
        } catch {
          // ignore malformed evidence
        }
      }
      return [
        `[${i + 1}] ${w.fullName} — ציון ${w.score}/100, ⭐${w.stars}`,
        `תיאור: ${w.description ?? "אין"}`,
        `מודלים שזוהו: ${models}`,
        notes ? `ראיות: ${notes}` : "",
        w.notes ? `הערות אנליסט שלנו: ${w.notes.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n---\n");

  const prompt = `רשימת המעקב שלנו (${items.length} מאגרים שזוהו כפרויקטי Claude בתשלום, סף מודלים 5.5+):

${list}

בצע סינתזת מודיעין חוצת-פרויקטים. אל תסתכל על כל ריפו בנפרד — מצא את החוט המקשר. החזר JSON בדיוק במבנה:
{
  "execSummary": "תמונת מצב אסטרטגית ב-3-4 משפטים: לאן השוק של פרויקטי Claude הפרימיום זז לפי הדפוסים כאן",
  "patterns": [{"pattern": "שם הדפוס", "repos": ["owner/name של הריפואים שבהם הופיע"], "insight": "מה המשמעות למוצר שלנו"}],
  "stackConsensus": ["טכנולוגיות/גישות שחוזרות על עצמן חוצה פרויקטים"],
  "topMoves": [{"move": "מהלך מומלץ למוצר שלנו", "why": "על בסיס אילו ראיות", "effort": "נמוך | בינוני | גבוה"}],
  "differentiators": ["3-5 הזדמנויות להבדלות — מה אף אחד מהם עדיין לא עשה"],
  "battlePlan": ["תוכנית פעולה מסודרת 4-7 סעיפים, מה ראשון ולמה"]
}
אם הרשימה קטנה ולא מספיקה לדפוסים — היה כן לגבי זה ב-execSummary ואל תמציא דפוסים.`;

  const j = await llmJson(prompt);
  return {
    execSummary: str(j.execSummary, "לא התקבל סיכום"),
    patterns: patternArr(j.patterns),
    stackConsensus: strArr(j.stackConsensus),
    topMoves: moveArr(j.topMoves),
    differentiators: strArr(j.differentiators),
    battlePlan: strArr(j.battlePlan),
    generatedAt: new Date().toISOString(),
  };
}
