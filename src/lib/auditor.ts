// ============================================================
// מודול הביקורת האדברסרית — המערכת בודקת את עצמה באכזריות.
// שלב א׳ (דטרמיניסטי, חי): לכל ממצא elite מוביל — חיפוש קוד במאגר עצמו
//   עם מחרוזת הראיה הנטענת. 0 קבצים = ראיה נסתרת. זה חושף בדיוק את
//   הכוזבות מסוג "אזכור בתיאור שקודם לתיאור בקוד".
// שלב ב׳ (LLM anti-slop): פרומפט ביקורתי שמקבל את התדריך + תוצאות שלב א׳
//   ונדרש לאתר טענות שאינן נתמכות, סלופ גנרי, ומספרים מומצאים.
// תוצאה נשמרת בשורת הסריקה עצמה — לא ניתן להתנצל, אפשר רק לתקן.
// צד שרת בלבד.
// ============================================================

import { db } from "./db";
import { extractJson, safeJsonParse, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import { ghFetch, ghFetchRaw, ghSearchWithBackoff } from "./github";
import { QUALIFYING_MODELS } from "./claude-models";
import { resolveToken } from "./server-token";
import type { NextRequest } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- טיפוסים ----------

export interface EvidenceCheck {
  fullName: string;
  claimed: string;
  filesFound: number;
  verified: boolean;
  /** קרקע-אמת: הקובץ המדויק שבו נמצאה המחרוזת */
  proofFile?: string;
  error?: string;
}

export interface SlopFlag {
  claim: string;
  why: string;
}

export interface AuditResult {
  status: "running" | "done" | "failed";
  stage: string;
  evidenceChecks: EvidenceCheck[];
  precision: number; // אחוז ראיות שאומתו מתוך נבדקו
  specificityScore: number; // 0-100 anti-slop
  slopFlags: SlopFlag[];
  refutedClaims: SlopFlag[];
  verdict: string;
  llmCalls: number;
  error?: string;
  auditedAt?: string;
}

interface FindingLike {
  fullName: string;
  stars: number;
  verdict: string | null;
  evidence: string;
  contentEvidence?: string[];
  textEvidence?: string[];
  investment?: number | null;
  signature?: string | null;
}

const AUDIT_TOP_N = 10;

const AUDITOR_ROLE = `אתה מבקר פנימי עוין (red-team) של יחידת מודיעין. תפקידך לחשוף סלופ, המצאות ונפוחות — אבל רק כאלה שבאמת קיימים.
כללי ברזל:
1. מנוע JSON בלבד — בלי code fences, בלי טקסט מחוץ ל-JSON.
2. עברית. אסורה מרכאה כפולה (") בתוך ערכי מחרוזת — גרש (') או ציטוט עברי (״).
3. חשדנות מבוססת-ראיות: הפרכה חייבת לצטט את הטענה המדויקת ולהצביע על הנתון הסותר מהנתונים שלפניך. אם אין סתירה אמיתית — החזר מערך ריק. אסור בתכלית להמציא הפרכות, מחרוזות שלא הופיעו (כמו undefined), או סתירות כשהכל מאומת.
4. הבחנה חוקית: ציון השקעה (inv) ו-moneyLevel הן הערכות מקצועיות מסומנות של המערכת — לא עובדות. אין לדגל אותן כהמצאה. המצאה = עובדה קונקרטית (מספר כוכבים, תאריך, שם קובץ, ציטוט, גודל) שאינה מופיעה בנתונים.
5. טרמינולוגיה מוגדרת של המערכת אינה סלופ: ראיה קשה = מחרוזת מודל 5.5+ שאומתה בתוכן קובץ אמיתי, לרוב עם נתיב מצורף. אין לדגל את המונח עצמו.
6. סלופ אמיתי = משפט גנרי שמתאים לכל פרויקט AI בלי פרט מזהה, או מספר/עובדה שלא קיימים בנתונים.`;

async function llmJson(prompt: string): Promise<Record<string, unknown>> {
  // התור הגלובלי (zai.ts) — מקביליות 1 + retry 429; role:"system" אמיתי
  const { content: raw } = await llmComplete(
    [
      { role: "system", content: AUDITOR_ROLE },
      { role: "user", content: prompt },
    ],
    { timeoutMs: 110_000, timeoutLabel: "ביקורת AI" }
  );
  if (!raw.trim()) throw new Error("ה-AI החזיר תשובה ריקה");
  return extractJson(raw, Error);
}

// ---------- שלב א׳: אימות ראיות חי ----------

/** קרקע-אמת: משיכת קובץ גולמי וגריפת המחרוזת — עוקף אי-עקביות של אינדקס החיפוש */
async function grepRawFile(
  fullName: string,
  path: string,
  claimedModelId: string,
  token: string | null
): Promise<string | null> {
  const model = QUALIFYING_MODELS.find((m) => m.id === claimedModelId);
  const needles = (model?.searchStrings ?? [claimedModelId]).map((s) => s.toLowerCase());
  try {
    const content = await ghFetchRaw(
      `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      token
    );
    const lower = content.toLowerCase();
    for (const n of needles) {
      if (lower.includes(n)) return path;
    }
  } catch {
    return null;
  }
  return null;
}

/** אימות חי: האם מחרוזת הראיה באמת בקבצי המאגר? (הגדרה: code search מתאים תוכן קובץ) */
export async function verifyEvidenceLive(
  findings: FindingLike[],
  token: string | null,
  onProgress?: (done: number, total: number, check: EvidenceCheck) => Promise<void> | void
): Promise<EvidenceCheck[]> {
  const targets = findings.filter((f) => f.verdict === "elite").slice(0, AUDIT_TOP_N);
  const checks: EvidenceCheck[] = [];
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i] as FindingLike & { evidencePaths?: string[] };
    const claimed = (f.contentEvidence && f.contentEvidence.length > 0 ? f.contentEvidence[0] : null) ?? null;
    if (!claimed) {
      const check: EvidenceCheck = { fullName: f.fullName, claimed: "(אין ראיית תוכן)", filesFound: 0, verified: false };
      checks.push(check);
      await onProgress?.(i + 1, targets.length, check);
      continue;
    }
    let check: EvidenceCheck;
    try {
      // מאמתים עד 2 מחרוזות נטענות לכל מאגר — לא רק את הראשונה
      const claims = (f.contentEvidence ?? []).slice(0, 2);
      let filesFound = 0;
      let verifiedAny = false;
      let lastClaim = claimed;
      for (const claim of claims) {
        lastClaim = claim;
        const resp = await ghSearchWithBackoff<{ total_count: number }>(
          `/search/code?q=${encodeURIComponent(`${claim} repo:${f.fullName}`)}&per_page=1`,
          token
        );
        filesFound += resp.total_count ?? 0;
        if ((resp.total_count ?? 0) > 0) verifiedAny = true;
        // מכסת code search = 10/דקה — 6.5s בין שאילתות אימות (בעבר 2.1s שרפו את המכסה
        // והפילו 403 על שאילתות ההמשך — ראיות אליטה נפסלו בשווא)
        await sleep(6_500);
      }
      check = { fullName: f.fullName, claimed: claims.join(" + "), filesFound, verified: verifiedAny };
      // קרקע-אמת: אם האינדקס מחטיא (0 קבצים) — גריפה ישירה של הקובץ שנתגלה בסריקה
      if (!check.verified) {
        const paths = f.evidencePaths ?? [];
        for (const p of paths) {
          const proof = await grepRawFile(f.fullName, p, lastClaim, token);
          if (proof) {
            check = { fullName: f.fullName, claimed: claims.join(" + "), filesFound: 1, verified: true, proofFile: proof };
            break;
          }
        }
      }
    } catch (e) {
      check = {
        fullName: f.fullName,
        claimed,
        filesFound: 0,
        verified: false,
        error: e instanceof Error ? e.message : "שגיאת אימות",
      };
    }
    checks.push(check);
    await onProgress?.(i + 1, targets.length, check);
    await sleep(6_500); // קצב מכסת code search (10 לדקה)
  }
  return checks;
}

// ---------- שלב ב׳: anti-slop ----------

function parseFlags(v: unknown, max = 8): SlopFlag[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): SlopFlag | null => {
      if (typeof x === "string") return { claim: x.slice(0, 300), why: "" };
      const o = (x ?? {}) as Record<string, unknown>;
      const claim = str(o.claim ?? o.statement ?? o.quote);
      if (!claim) return null;
      return { claim: claim.slice(0, 300), why: str(o.why ?? o.reason).slice(0, 300) };
    })
    .filter((x): x is SlopFlag => !!x)
    .slice(0, max);
}

export async function antiSlopAudit(
  briefing: Record<string, unknown> | null,
  checks: EvidenceCheck[],
  findings: FindingLike[]
): Promise<{ specificityScore: number; slopFlags: SlopFlag[]; refutedClaims: SlopFlag[]; verdict: string }> {
  const refuted = checks.filter((c) => !c.verified);
  const briefSample = JSON.stringify(briefing ?? {}).slice(0, 4500);
  const refutedList = refuted.length
    ? refuted.map((r) => `— ${r.fullName}: נטען "${r.claimed}" אך 0 קבצים במאגר מכילים אותה`).join("\n")
    : "(אף ראיה לא נסתרה בשלב הדטרמיניסטי)";
  const topFindings = findings
    .slice(0, 10)
    .map((f) => `— ${f.fullName}: inv=${f.investment ?? "?"} חתימה: ${(f.signature ?? "").slice(0, 120)}`)
    .join("\n");

  const prompt = `ביקורת anti-slop על תדריך מודיעין שייצרה המערכת.

1) תוצאות אימות חי (דטרמיניסטי) של ראיות ה-elite — הקרקע-אמת שאין לערער עליה:
${checks.map((c) => `— ${c.fullName}: נטען "${c.claimed}" → ${c.filesFound} קבצים נמצאו ${c.verified ? `✓ אומתה${c.proofFile ? ` (קובץ הוכחה: ${c.proofFile})` : ""}` : "✗ נסתרה"}`).join("\n")}

2) ראיות שנסתרו:
${refutedList}

3) ממצאי הצמרת כפי שדווחו:
${topFindings}

4) התדריך שנבדק (קטע):
${briefSample}

בדוק בקנאות אך ביושר:
א. טענות בתדריך שסותרות את האימות החי — רק אם יש סתירה מילולית בין טענה מצוטטת לנתון מצוטט.
ב. מספרים/עובדות קונקרטיות שלא מופיעים בנתונים (המצאה) — לא הערכות מסומנות כמו inv.
ג. סלופ גנרי — משפט שמתאים לכל דוח בלי פרט מזהה.
אם אין בעיות אמיתיות בקטגוריה — החזר מערך ריק. אסור להמציא.
החזר JSON בדיוק:
{"specificityScore": 0-100, "slopFlags": [{"claim": "...", "why": "..."}], "refutedClaims": [{"claim": "...", "why": "..."}], "verdict": "2-3 משפטים: כמה הדוח אמין ומה חייב תיקון"}`;

  const j = await llmJson(prompt);
  const score = Number(j.specificityScore ?? j.score ?? 50);
  return {
    specificityScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    slopFlags: parseFlags(j.slopFlags),
    refutedClaims: parseFlags(j.refutedClaims),
    verdict: str(j.verdict, "לא התקבל פסק ביקורת"),
  };
}

// ---------- ריצת ביקורת מלאה ----------

const activeAudits = new Set<number>();

export function isAuditActive(id: number): boolean {
  return activeAudits.has(id);
}

async function writeAudit(id: number, audit: AuditResult): Promise<void> {
  try {
    await db.sweepRun.update({ where: { id }, data: { audit: JSON.stringify(audit) } });
  } catch {
    // הריצה נמחקה
  }
}

async function executeAudit(runId: number, token: string | null): Promise<void> {
  activeAudits.add(runId);
  try {
    const row = await db.sweepRun.findUnique({ where: { id: runId } });
    if (!row) throw new Error("הסריקה לא נמצאה");
    const findings = safeJsonParse<FindingLike[]>(row.findings, []);
    if (findings.length === 0) throw new Error("אין ממצאים לביקורת — הריצה לא השלימה");
    const briefing = safeJsonParse<Record<string, unknown> | null>(row.briefing, null);

    // שלב א׳
    await writeAudit(runId, {
      status: "running", stage: "evidence", evidenceChecks: [], precision: 0,
      specificityScore: 0, slopFlags: [], refutedClaims: [], verdict: "", llmCalls: 0,
    });
    const checks = await verifyEvidenceLive(findings, token);
    const verifiedCount = checks.filter((c) => c.verified).length;
    const precision = checks.length ? Math.round((verifiedCount / checks.length) * 100) : 0;

    // שלב ב׳
    await writeAudit(runId, {
      status: "running", stage: "antislop", evidenceChecks: checks, precision,
      specificityScore: 0, slopFlags: [], refutedClaims: [], verdict: "", llmCalls: 0,
    });
    const slop = await antiSlopAudit(briefing, checks, findings);

    const result: AuditResult = {
      status: "done",
      stage: "done",
      evidenceChecks: checks,
      precision,
      specificityScore: slop.specificityScore,
      slopFlags: slop.slopFlags,
      refutedClaims: slop.refutedClaims,
      verdict: slop.verdict,
      llmCalls: 1,
      auditedAt: new Date().toISOString(),
    };
    await writeAudit(runId, result);
  } catch (e) {
    await writeAudit(runId, {
      status: "failed",
      stage: "failed",
      evidenceChecks: [],
      precision: 0,
      specificityScore: 0,
      slopFlags: [],
      refutedClaims: [],
      verdict: "",
      llmCalls: 0,
      error: e instanceof Error ? e.message : "שגיאת ביקורת",
    });
  } finally {
    activeAudits.delete(runId);
  }
}

/** פתיחת ביקורת ברקע */
export async function startAudit(req: NextRequest, runId: number): Promise<void> {
  const row = await db.sweepRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!row) {
    const err = new Error("הסריקה לא נמצאה");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  // נעילה סינכרונית לפני כל await — סוגר את חלון ה-TOCTOU
  // (בעבר: ה-ID נרשם רק בתוך executeAudit אחרי כמה await — שני POST מקביליים הריצו ביקורת כפולה)
  if (activeAudits.has(runId)) {
    const err = new Error("ביקורת כבר רצה על הסריקה הזו");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  activeAudits.add(runId);
  try {
    const current = await db.sweepRun.findUnique({ where: { id: runId }, select: { audit: true } });
    const running = safeJsonParse<{ status?: string }>(current?.audit ?? null, {});
    if (running.status === "running") {
      const err = new Error("ביקורת כבר רצה על הסריקה הזו");
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const token = await resolveToken(req);
    void executeAudit(runId, token);
  } catch (e) {
    activeAudits.delete(runId); // כשל מוקדם — משחררים את הנעילה
    throw e;
  }
}

export function parseAudit(raw: string | null): AuditResult | null {
  return safeJsonParse<AuditResult | null>(raw, null);
}
