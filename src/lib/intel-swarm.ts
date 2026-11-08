// ============================================================
// להקת פרומפטים — מודיעין עומק מרובה-שלבים
// במקום פרומפט אחד כללי: 8 פרומפטים מקצועיים עם תפקידים מומחים —
// טריאז׳ה ראיות ← פרופילי השקעה ← דפוסי שוק ← תוכנית תקיפה
// ← אבולוציית שאילתות ← תדריך מנהלים.
// כל פרומפט מחזיר JSON קפדני עם שרשרת תיקון. צד שרת בלבד.
// ============================================================

import { extractJson, isTimeoutError, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import type { CandidateFlat } from "./deep-sweep";

export class SwarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmError";
  }
}

const TIMEOUT_MS = 110_000;

const SWARM_ROLE = `אתה קצין מודיעין בכיר ביחידת צייד טכנולוגי. אתה חד, חשדן ומבוסס-ראיות.
כללי ברזל:
1. אתה מנוע JSON — מחזיר JSON תקין ותו לא מעבר. בלי code fences, בלי הסברים.
2. עברית בלבד (מונחים טכניים באנגלית בתוך הטקסט).
3. אסור להמציא. אין ראיה? כתוב שלא נמצאה. חשדן כלפי ראיות חלשות.
4. סף המודלים: רק 5.5+ (Opus 5.5, Fable, Opus 6+) נחשב פרימיום. משפחת 4.x זבל — אפס ערך.
5. בתוך ערכי מחרוזת אסורה מרכאה כפולה (") — גרש (') או מירכאות עבריות (״).`;

const RETRY_HINT = `\n\n⚠️ תיקון: התשובה הקודמת לא הייתה JSON תקין. החזר את אותו תוכן ב-JSON מהודק — בלי מרכאות כפולות בערכים, בלי פסיקים תלויים, גוף ה-JSON בלבד.`;

async function llmJson(userPrompt: string): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // התור הגלובלי ב-zai.ts מסדר את כל קריאות ה-AI בתהליך (מקביליות 1)
      // — שתי מנועות שרצות יחד (כימרה בזמן סריקה) כבר לא מפילות 429
      // זו של זו. role:"system" — הוראות המערכת מקבלות עדיפות אמיתית.
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: SWARM_ROLE },
          { role: "user", content: attempt === 0 ? userPrompt : userPrompt + RETRY_HINT },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "קריאת ה-AI", timeoutError: SwarmError }
      );
      if (!raw.trim()) {
        lastErr = new SwarmError("ה-AI החזיר תשובה ריקה");
        continue;
      }
      return extractJson(raw, SwarmError);
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — בלי retry, 8+ פרומפטים × 110 שניות = מלכודת
      if (e instanceof SwarmError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new SwarmError("פרומפט נכשל");
}

// ---------- עזרי דיוג ----------

function candidateLine(c: CandidateFlat, i: number): string {
  const provenance =
    c.contentEvidence.length > 0
      ? `קשה-מאומתת (המחרוזת בתוכן קובץ אמיתי: ${c.contentEvidence.join(", ")})`
      : c.textEvidence.length > 0
        ? `רכה בלבד (רק אזכור בתיאור/topics, לא הוכחה בקוד: ${c.textEvidence.join(", ")})`
        : "חלשה (אזכור claude כללי)";
  return [
    `[${i}] ${c.fullName}`,
    `⭐${c.stars} · דחיפה אחרונה: ${c.pushedAt?.slice(0, 10) ?? "??"} · ראיה: ${provenance}`,
    c.contentEvidence.length > 0 && c.evidencePaths.length > 0
      ? `קבצי ראיה ממאגר אמיתי: ${c.evidencePaths.slice(0, 3).join(" | ")}`
      : "",
    c.description ? `תיאור: ${c.description.slice(0, 200)}` : "תיאור: אין",
    c.capabilityHits ? `קבצי יכולת שנתגלו: ${c.capabilityHits}` : "",
    c.topics.length ? `topics: ${c.topics.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- P1+P2: טריאז׳ה ----------

export interface TriageVerdict {
  fullName: string;
  verdict: "elite" | "watch" | "noise";
  confidence: number;
  reason: string;
}

function parseTriage(j: Record<string, unknown>, batch: CandidateFlat[]): TriageVerdict[] {
  const raw = Array.isArray(j.verdicts) ? j.verdicts : [];
  const out: TriageVerdict[] = [];
  const valid = new Set(batch.map((c) => c.fullName));
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const fullName = str(o.fullName ?? o.repo);
    if (!valid.has(fullName)) continue;
    const v = str(o.verdict).toLowerCase();
    const verdict: TriageVerdict["verdict"] =
      v.includes("elite") || v.includes("אליט") ? "elite" : v.includes("watch") || v.includes("מעקב") ? "watch" : "noise";
    const conf = Number(o.confidence ?? o.confidenceScore ?? 50);
    out.push({
      fullName,
      verdict,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : 50,
      reason: str(o.reason ?? o.why, "ללא נימוק"),
    });
  }
  return out;
}

/** פרומפטי טריאז׳ה — מחזיר פסק דין לכל מועמד באצווה */
export async function triageBatch(batch: CandidateFlat[]): Promise<TriageVerdict[]> {
  const list = batch.map((c, i) => candidateLine(c, i)).join("\n---\n");
  const prompt = `רשימת מועמדים מסריקת GitHub (סף מודלים 5.5+ בלבד):

${list}

בצע טריאז׳ה מודיעינית השוואתית. הכללים:
— ראיה ״קשה-מאומתת״ = המחרוזת נמצאה בתוכן קובץ אמיתי — תנאי הכרחי ל-elite, אבל לא מספיק.
— elite = רק החזקים באמת מול המטרה: השקעה כספית מוכחת במודלי פרימיום 5.5+ ויכולות .claude אמתיות. אם כל המועמדים נראים דומים, דרג אותם זה מול זה ותן elite רק לשליש החזק ביותר — השאר watch עם נימוק מה חסר להם.
— ראיה ״רכה״ = אזכור בתיאור בלבד — אסור לתת elite, לכל היותר watch. אסור לומר שהשתמשו במודל בקוד.
— בלי ראיה = noise.
— אסור לסמן את כל הרשימה elite. פיזור אמיתי: אם היית שופט שוב ושוב ותמיד כולם elite — הטריאז׳ה שלך חסרת ערך.
החזר JSON בדיוק:
{"verdicts": [{"fullName": "owner/name", "verdict": "elite|watch|noise", "confidence": 0-100, "reason": "נימוק קצר בעברית המציין בדיוק מאיפה הראיה (תוכן קוד / תיאור) ולמה זה טוב/חלש יחסית לאחרים"}]}`;
  const j = await llmJson(prompt);
  return parseTriage(j, batch);
}

// ---------- P3+P4: פרופילי השקעה חדים ----------

export interface SharpProfile {
  fullName: string;
  investment: number;
  moneyLevel: string;
  signature: string;
  stealThis: string[];
  blindSpot: string;
}

function parseProfiles(j: Record<string, unknown>, batch: CandidateFlat[]): SharpProfile[] {
  const raw = Array.isArray(j.profiles) ? j.profiles : [];
  const valid = new Set(batch.map((c) => c.fullName));
  const out: SharpProfile[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const fullName = str(o.fullName ?? o.repo);
    if (!valid.has(fullName)) continue;
    const inv = Number(o.investment ?? o.investmentScore ?? 0);
    out.push({
      fullName,
      investment: Number.isFinite(inv) ? Math.max(0, Math.min(100, Math.round(inv))) : 0,
      moneyLevel: str(o.moneyLevel, "לא ידוע"),
      signature: str(o.signature ?? o.whatTheyBuilt),
      stealThis: strArr(o.stealThis, 3),
      blindSpot: str(o.blindSpot ?? o.weakness),
    });
  }
  return out;
}

/** פרומפטי פרופילים — למועמדי הצמרת בלבד */
export async function sharpProfiles(batch: CandidateFlat[]): Promise<SharpProfile[]> {
  const list = batch.map((c, i) => candidateLine(c, i)).join("\n---\n");
  const prompt = `הצמרת של הסריקה — מועמדים עם הראיות הקשות ביותר להשקעה במודלי Claude 5.5+:

${list}

לכל אחד בנה פרופיל השקעה חד. על בסיס הראיות בלבד:
{"profiles": [{"fullName": "owner/name", "investment": 0-100, "moneyLevel": "בטוח|סביר|חלש", "signature": "מה בנו שם שדורש מודל פרימיום", "stealThis": ["מה לגנוב למוצר שלנו"], "blindSpot": "מה הם לא רואים ואנחנו כן"}]}`;
  const j = await llmJson(prompt);
  return parseProfiles(j, batch);
}

// ---------- P5: דפוסי שוק ----------

export interface MarketPatterns {
  patterns: { pattern: string; repos: string[]; insight: string }[];
  stackConsensus: string[];
  marketShift: string;
}

export async function patternSynthesis(
  elite: CandidateFlat[],
  watch: CandidateFlat[]
): Promise<MarketPatterns> {
  const list = [...elite, ...watch.slice(0, 12)]
    .map((c, i) => candidateLine(c, i))
    .join("\n---\n");
  const prompt = `תמונת השוק מהסריקה — אליטה (${elite.length}) + מעקב (${watch.length}):

${list}

מצא דפוסים חוצי-מאגרים: מה בונים עם מודלי 5.5+? אילו סוגי מוצרים משלמים? לאן השוק זז?
{"patterns": [{"pattern": "שם הדפוס", "repos": ["owner/name"], "insight": "המשמעות למוצר שלנו"}], "stackConsensus": ["טכנולוגיות שחוזרות"], "marketShift": "2-3 משפטים: לאן השוק של שימושי Claude פרימיום זז"}`;
  const j = await llmJson(prompt);
  const patternsRaw = Array.isArray(j.patterns) ? j.patterns : [];
  return {
    patterns: patternsRaw
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const pattern = str(o.pattern ?? o.title);
        if (!pattern) return null;
        return { pattern, repos: strArr(o.repos, 12), insight: str(o.insight ?? o.meaning) };
      })
      .filter((p): p is MarketPatterns["patterns"][number] => !!p)
      .slice(0, 8),
    stackConsensus: strArr(j.stackConsensus, 10),
    marketShift: str(j.marketShift, "לא התקבל שיפוט שוק"),
  };
}

// ---------- P6: תוכנית תקיפה ----------

export interface AttackPlan {
  topMoves: { move: string; why: string; effort: string }[];
  differentiators: string[];
  immediateActions: string[];
}

export async function attackPlan(
  elite: CandidateFlat[],
  profiles: SharpProfile[],
  patterns: MarketPatterns
): Promise<AttackPlan> {
  const profList = profiles
    .map(
      (p) =>
        `${p.fullName}: השקעה ${p.investment}/100 (${p.moneyLevel}) — חתימה: ${p.signature.slice(0, 150)}${
          p.blindSpot ? ` · נקודה עיוורת: ${p.blindSpot.slice(0, 150)}` : ""
        }`
    )
    .join("\n");
  const patList = patterns.patterns.map((p) => `— ${p.pattern}: ${p.insight.slice(0, 150)}`).join("\n");
  const prompt = `אתה בונה ממשק AI מתחרה. הנה המודיעין מהסריקה:

פרופילי השקעה:
${profList || "אין פרופילים"}

דפוסי שוק:
${patList || "אין דפוסים"}

נסח תוכנית תקיפה אכזרית וממוקדת:
{"topMoves": [{"move": "מהלך", "why": "על בסיס איזה מודיעין", "effort": "נמוך|בינוני|גבוה"}], "differentiators": ["מה אף מתחרה לא עשה"], "immediateActions": ["צעדים ל-48 שעות הקרובות"]}`;
  const j = await llmJson(prompt);
  const movesRaw = Array.isArray(j.topMoves) ? j.topMoves : [];
  return {
    topMoves: movesRaw
      .map((m) => {
        const o = (m ?? {}) as Record<string, unknown>;
        const move = str(o.move ?? o.action ?? o.title);
        if (!move) return null;
        return { move, why: str(o.why ?? o.reason), effort: str(o.effort, "בינוני") };
      })
      .filter((m): m is AttackPlan["topMoves"][number] => !!m)
      .slice(0, 8),
    differentiators: strArr(j.differentiators, 6),
    immediateActions: strArr(j.immediateActions, 8),
  };
}

// ---------- P7: אבולוציית שאילתות ----------

export interface QueryEvolution {
  nextQueries: string[];
  blindSpots: string[];
  rationale: string;
}

export async function queryEvolution(
  executedQueries: { q: string; count: number; error?: string | null }[],
  elite: CandidateFlat[]
): Promise<QueryEvolution> {
  const perQuery = executedQueries
    .map((r) => `— [${r.error ? `שגיאה: ${String(r.error).slice(0, 60)}` : `${r.count} תוצאות`}] ${r.q}`)
    .join("\n");
  const dead = executedQueries.filter((r) => !r.error && r.count === 0).slice(0, 8);
  const deadList = dead.map((r) => r.q).join(" | ") || "אין";
  const prompt = `הרצנו את השאילתות הבאות ב-GitHub — עם מספר התוצאות האמיתי של כל אחת:
${perQuery}

ומצאנו ${elite.length} מאגרי אליטה: ${elite.slice(0, 15).map((c) => c.fullName).join(", ") || "אין"}

כללים קשוחים:
1. שאילתה עם 0 תוצאות היא מתה — אסור לחזור על דפוס שלה. מתות שכבר זוהו: ${deadList}
2. אסור להמציא מתאמי repo:owner/name — owner/name חוקי רק מהרשימת האליטה האמיתית למעלה, ורק אם רוצים לצלול לעומק של מאגר ספציפי.
3. שאילתה שמחזירה מאות אלפי תוצאות היא רעש יותר מאותת — צמצם עם מילות ראיה ספציפיות (למשל שמות קבצים, מחרוזות תצורה, שמות משתני סביבה) שקיימות בקוד של צרכני מודלי 5.5+.
4. שאף ל-8-12 שאילתות שכל אחת מהן צפויה להחזיר 5-200 תוצאות איכותיות.

הצע את הסבב הבא: אילו שאילתות GitHub יחשפו את מה שפספסנו?
{"nextQueries": ["8-12 שאילתות חדשות בתחביר GitHub (code/repo search), ממוקדות עוד יותר בראיות של מודלי 5.5+"], "blindSpots": ["מה הסריקה הנוכחית לא רואה"], "rationale": "למה דווקא אלה"}`;
  const j = await llmJson(prompt);
  return {
    nextQueries: strArr(j.nextQueries, 12),
    blindSpots: strArr(j.blindSpots, 6),
    rationale: str(j.rationale),
  };
}

// ---------- P8: תדריך מנהלים ----------

export interface ExecBrief {
  headline: string;
  keyIntel: string[];
  decisiveMove: string;
  riskMap: string[];
}

export async function execBrief(input: {
  statsLine: string;
  eliteCount: number;
  patterns: MarketPatterns;
  attack: AttackPlan;
  dnaAdded: number;
}): Promise<ExecBrief> {
  const prompt = `סגור את המבצע בתדריך מנהלים חד-עמודי.

נתוני המבצע: ${input.statsLine}
מאגרי אליטה: ${input.eliteCount}
DNA חדש שנכרה: ${input.dnaAdded}

דפוסים: ${input.patterns.patterns.map((p) => p.pattern).join("; ") || "אין"}
מהלכים מובילים: ${input.attack.topMoves.map((m) => m.move).slice(0, 5).join("; ") || "אין"}

{"headline": "כותרת אחת שמסכמת את ממצא המלחמה", "keyIntel": ["3-5 ממצאים קריטיים"], "decisiveMove": "המהלך המכריע האחד לשבוע הקרוב", "riskMap": ["סיכונים ונחשולים"]}`;
  const j = await llmJson(prompt);
  return {
    headline: str(j.headline, "לא התקבלה כותרת"),
    keyIntel: strArr(j.keyIntel, 6),
    decisiveMove: str(j.decisiveMove),
    riskMap: strArr(j.riskMap, 6),
  };
}

// ---------- ריצת הלהקה המלאה ----------

export interface SwarmResult {
  triage: TriageVerdict[];
  profiles: SharpProfile[];
  patterns: MarketPatterns;
  attack: AttackPlan;
  queryEvolution: QueryEvolution;
  brief: ExecBrief;
  llmCalls: number;
  llmFailures: string[];
}

/**
 * ריצה מלאה: 8 פרומפטים (2 טריאז׳ה + 2 פרופילים + דפוסים + תקיפה + שאילתות + תדריך).
 * סלחנית לכשלים חלקיים: פרומפט שנכשל לא מפיל את המבצע — נרשם ב-failures.
 * executedQueries חייב להיות אובייקטים {q,count,error} — בעבר החתימה הצהירה string[]
 * וכל מי שהעביר מחרוזות גרם ל-"undefined תוצאות" בפרומפט אבולוציית השאילתות
 * ולרשימת שאילתות-מתות ריקה תמידית (באג אמיתי שסוגר כאן ברמת הטיפוס).
 */
/** כיסוי הטריאז׳ה — מספר הממצאים שמקבלים פסק-דין מהלהקה.
 * מיוצא כדי שהשומר והממצאים הנשמרים יסכמו תמיד לאותו מספר — בעבר נשמרו
 * 60 ממצאים כשרק 36 קיבלו verdict, והשורות 37-60 הציגו "ממתין" לנצח. */
export const SWARM_TRIAGE_COVERAGE = 36;

export async function runSwarm(
  candidates: CandidateFlat[],
  executedQueries: { q: string; count: number; error?: string | null }[],
  dnaAdded: number,
  statsLine: string,
  onProgress?: (done: number, total: number) => Promise<void> | void
): Promise<SwarmResult> {
  const failures: string[] = [];
  let calls = 0;

  // טריאז׳ה באצוות של 12
  const batches = chunk(candidates.slice(0, SWARM_TRIAGE_COVERAGE), 12);
  const triage: TriageVerdict[] = [];
  const totalPrompts = batches.length * 2 + 4;

  for (const batch of batches) {
    try {
      calls++;
      triage.push(...(await triageBatch(batch)));
    } catch (e) {
      failures.push(`טריאז׳ה: ${e instanceof Error ? e.message : "שגיאה"}`);
    }
    await onProgress?.(calls, totalPrompts);
  }

  const eliteNames = new Set(triage.filter((t) => t.verdict === "elite").map((t) => t.fullName));
  const elite = candidates.filter((c) => eliteNames.has(c.fullName)).slice(0, 12);
  const watchNames = new Set(triage.filter((t) => t.verdict === "watch").map((t) => t.fullName));
  const watch = candidates.filter((c) => watchNames.has(c.fullName)).slice(0, 12);

  // פרופילים — רק לאליטה, באצוות של 6
  const profiles: SharpProfile[] = [];
  for (const batch of chunk(elite, 6)) {
    try {
      calls++;
      profiles.push(...(await sharpProfiles(batch)));
    } catch (e) {
      failures.push(`פרופילים: ${e instanceof Error ? e.message : "שגיאה"}`);
    }
    await onProgress?.(calls, totalPrompts);
  }

  const safePatterns: MarketPatterns = { patterns: [], stackConsensus: [], marketShift: "" };
  let patterns = safePatterns;
  try {
    calls++;
    patterns = await patternSynthesis(elite, watch);
  } catch (e) {
    failures.push(`דפוסים: ${e instanceof Error ? e.message : "שגיאה"}`);
  }
  await onProgress?.(calls, totalPrompts);

  const safeAttack: AttackPlan = { topMoves: [], differentiators: [], immediateActions: [] };
  let attack = safeAttack;
  try {
    calls++;
    attack = await attackPlan(elite, profiles, patterns);
  } catch (e) {
    failures.push(`תוכנית תקיפה: ${e instanceof Error ? e.message : "שגיאה"}`);
  }
  await onProgress?.(calls, totalPrompts);

  let queries: QueryEvolution = { nextQueries: [], blindSpots: [], rationale: "" };
  try {
    calls++;
    queries = await queryEvolution(executedQueries, elite);
  } catch (e) {
    failures.push(`אבולוציית שאילתות: ${e instanceof Error ? e.message : "שגיאה"}`);
  }
  await onProgress?.(calls, totalPrompts);

  let brief: ExecBrief = { headline: "", keyIntel: [], decisiveMove: "", riskMap: [] };
  try {
    calls++;
    brief = await execBrief({
      statsLine,
      eliteCount: elite.length,
      patterns,
      attack,
      dnaAdded,
    });
  } catch (e) {
    failures.push(`תדריך: ${e instanceof Error ? e.message : "שגיאה"}`);
  }
  await onProgress?.(calls, totalPrompts);

  return { triage, profiles, patterns, attack, queryEvolution: queries, brief, llmCalls: calls, llmFailures: failures };
}
