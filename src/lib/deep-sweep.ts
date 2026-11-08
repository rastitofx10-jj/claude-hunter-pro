// ============================================================
// מנוע סריקת עומק — Claude Hunter
// סבב מודיעין מקצועי מלא: ארסנל שאילתות רחב (קוד + מאגרים)
// ← העשרת מטא-דאטה ← דירוג מבוסס ראיות ← כריית DNA.
// זה הצעד מ"שתי שאילתות קבועות" לארסנל אמיתי שמתעדכן מרישום המודלים.
// פועל בצד שרת בלבד.
// ============================================================

import { ghSearchWithBackoff, ghGraphql, computeListScore, tierOf, type TierKey } from "./github";
import { QUALIFYING_MODELS, detectClaudeModels } from "./claude-models";
import { harvestRepo, batchRepoMeta } from "./harvester";
import { db } from "./db";

// ---------- ארסנל השאילתות ----------

export interface SweepQuery {
  q: string;
  kind: "code" | "repo";
  /** מאיפה השאילתה: registry (מודל רשום) | capability | topic | market */
  origin: string;
}

/** בונה את ארסנל השאילתות המלא מתוך רישום המודלים — תמיד מסונכרן עם הסף */
export function buildQueryArsenal(): SweepQuery[] {
  const queries: SweepQuery[] = [];

  // 1. כל מחרוזת חיפוש של כל מודל מזכה — חיפוש קוד ישיר (הראיה הקשה)
  for (const m of QUALIFYING_MODELS) {
    for (const s of m.searchStrings) {
      queries.push({ q: s, kind: "code", origin: `registry:${m.id}` });
    }
  }

  // 2. שאילתות יכולת — קבצי יכולת Claude עם מחרוזות פרימיום
  queries.push(
    { q: "SKILL.md claude", kind: "code", origin: "capability" },
    { q: "claude-code commands", kind: "code", origin: "capability" },
    { q: "claude agents orchestration", kind: "code", origin: "capability" },
    { q: "anthropic max tokens opus", kind: "code", origin: "capability" },
  );

  // 3. חיפושי מאגרים — השוק הרחב של פרויקטי Claude פעילים
  // (120 יום — בעבר נקרא בטעות monthAgo; שם המשתנה הטעה את כולם)
  const freshSince = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  queries.push(
    { q: `claude opus 5.5 stars:>5 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `claude fable stars:>3 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `claude code agent stars:>100 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `topic:claude-code stars:>30`, kind: "repo", origin: "topic" },
    { q: `topic:claude-agents stars:>10`, kind: "repo", origin: "topic" },
    { q: `topic:mcp topic:claude stars:>10`, kind: "repo", origin: "topic" },
    { q: `anthropic premium api integration stars:>20 pushed:>${freshSince}`, kind: "repo", origin: "market" },
  );

  return queries;
}

// ---------- גילוי מועמדים ----------

export interface CodeHit {
  path: string;
  repo: string;
  capability: boolean;
  /** השאילתה שמצאה את הקובץ — GitHub קוד-סרץ' מתאים תוכן קובץ, ולכן זו הוכחה שהמחרוזת בתוכן */
  viaQuery: string;
}

export interface RepoHit {
  fullName: string;
  description: string | null;
  stars: number;
  pushedAt: string | null;
  topics: string[];
}

export interface Candidate {
  fullName: string;
  stars: number;
  description: string | null;
  pushedAt: string | null;
  topics: string[];
  /** הוכחה: נמצא בתוכן קובץ אמיתי (GitHub code search מתאים תוכן) — ראיה קשה */
  contentEvidence: string[];
  /** ענף ברירת המחדל מה-GraphQL — חוסך קריאת /repos בכרייה */
  defaultBranch?: string | null;
  /** נמצא רק בתיאור/topics/נתיב — ראיה רכה, לא הוכחה של שימוש בקוד */
  textEvidence: string[];
  /** נתיבי קבצים אמיתיים שבהם נמצאה מחרוזת מודל רשומה — קרקע-אמת לאימות חוזר */
  evidencePaths: string[];
  /** לתצוגה: איחוד שני המקורות */
  modelStrings: string[];
  /** כמה קבצי יכולת נתגלו (SKILL.md, .claude/ וכו') */
  capabilityHits: number;
  /** דיוק ראיית המודל: hard (מחרוזת מודל בתוכן קוד — מאומת) | soft (אזכור בתיאור/נתיב) | none */
  evidence: "hard" | "soft" | "none";
  score: number;
  /** מקורות הגילוי */
  via: string[];
}

interface GhCodeItem {
  path: string;
  repository?: {
    full_name: string;
    stargazers_count?: number;
    pushed_at?: string;
    description?: string | null;
  };
}

interface GhRepoItem {
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  topics?: string[];
}

interface GhSearchResp<T> {
  total_count: number;
  items: T[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// (searchWithBackoff moved to github.ts as ghSearchWithBackoff — one source of truth;
//  the local copy had a dead backoff: it matched "rate limit" inside a message
//  that ghFetch had already translated to Hebrew, so rate-limited queries were
//  thrown permanently instead of waiting 8s/16s/32s and retrying.)

function isCapabilityPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("skill.md") ||
    p.includes(".claude/commands/") ||
    p.includes(".claude/agents/") ||
    p === "claude.md" ||
    p === "agents.md"
  );
}

/**
 * שלב א׳ — ירי כל השאילתות בקצב בטוח למכסת החיפוש (30/דקה),
 * עם דיווח התקדמות אחרי כל שאילתה.
 */
export interface QueryReport {
  q: string;
  kind: string;
  origin: string;
  count: number;
  error?: string;
}

export async function runQueryArsenal(
  token: string | null,
  queries: SweepQuery[],
  onProgress: (report: QueryReport, done: number, total: number) => Promise<void> | void
): Promise<{ reports: QueryReport[]; codeHits: CodeHit[]; repoHits: RepoHit[] }> {
  const reports: QueryReport[] = [];
  const codeHits: CodeHit[] = [];
  const repoHits: RepoHit[] = [];
  const seenCode = new Set<string>(); // repo:path dedup

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    let report: QueryReport = { q: query.q, kind: query.kind, origin: query.origin, count: 0 };
    try {
      if (query.kind === "code") {
        const resp = await ghSearchWithBackoff<GhSearchResp<GhCodeItem>>(
          `/search/code?q=${encodeURIComponent(query.q)}&per_page=100&page=1`,
          token
        );
        report.count = resp.total_count ?? 0;
        for (const item of resp.items ?? []) {
          const r = item.repository;
          if (!r?.full_name) continue;
          const key = `${r.full_name}::${item.path}`;
          if (seenCode.has(key)) continue;
          seenCode.add(key);
          codeHits.push({ path: item.path, repo: r.full_name, capability: isCapabilityPath(item.path), viaQuery: query.q });
        }
      } else {
        const resp = await ghSearchWithBackoff<GhSearchResp<GhRepoItem>>(
          `/search/repositories?q=${encodeURIComponent(query.q)}&per_page=50&page=1`,
          token
        );
        report.count = resp.total_count ?? 0;
        for (const item of resp.items ?? []) {
          repoHits.push({
            fullName: item.full_name,
            description: item.description ?? null,
            stars: item.stargazers_count ?? 0,
            pushedAt: item.pushed_at ?? null,
            topics: item.topics ?? [],
          });
        }
      }
    } catch (e) {
      report = { ...report, count: 0, error: e instanceof Error ? e.message : "שגיאה" };
    }
    reports.push(report);
    await onProgress(report, i + 1, queries.length);
    // קצב מותאם סוג שאילתה: code search מקבל מכסה נפרדת ומחמירה (10 לדקה)
    // — 2.1s מספיק ל-repositories אבל שורף את מכסת הקוד אחרי ~10 שאילתות.
    // (בעבר: 2.1s לכולם → שאילתות קוד 403-וות ונרשמו כשגיאות)
    if (i < queries.length - 1) await sleep(query.kind === "code" ? 6_500 : 2_100);
  }

  return { reports, codeHits, repoHits };
}

/** שלב ב׳ — איחוד גילויים למועמדים מדורגים לפי ראיות, עם הפרדת מקורות מחמירה:
 *  — contentEvidence: GitHub code search התאים את המחרוזת בתוכן קובץ אמיתי (מאומת)
 *  — textEvidence: המחרוזת מופיעה רק בתיאור/topics/נתיב (לא הוכחה של קוד)
 *  — evidence=hard אך ורק אם יש contentEvidence. אין קידום תיאור ל"קוד". */
export function consolidateCandidates(
  codeHits: CodeHit[],
  repoHits: RepoHit[]
): Candidate[] {
  const map = new Map<string, Candidate>();

  const ensure = (fullName: string): Candidate => {
    let c = map.get(fullName);
    if (!c) {
      c = {
        fullName,
        stars: 0,
        description: null,
        pushedAt: null,
        topics: [],
        contentEvidence: [],
        textEvidence: [],
        evidencePaths: [],
        modelStrings: [],
        capabilityHits: 0,
        evidence: "none",
        score: 0,
        via: [],
      };
      map.set(fullName, c);
    }
    return c;
  };

  // מיפוי שאילתה → מזהה מודל רשומי (לפי ה-origin של הארסנל)
  const queryToModel = new Map<string, string>();
  for (const m of QUALIFYING_MODELS) {
    for (const s of m.searchStrings) queryToModel.set(s.toLowerCase(), m.id);
  }

  for (const hit of codeHits) {
    const c = ensure(hit.repo);
    if (hit.capability) c.capabilityHits++;
    // הוכחת תוכן רק למחרוזת מודל רשומה: השאילתה נמצאה בתוכן הקובץ, אבל
    // שאילתות יכולת/שוק (למשל SKILL.md claude) אינן הוכחת מודל — רק סימן soft.
    const asModel = queryToModel.get(hit.viaQuery.toLowerCase());
    if (asModel) {
      if (!c.contentEvidence.includes(asModel)) c.contentEvidence.push(asModel);
      // שמירת נתיב הקובץ האמיתי — קרקע-אמת לאימות חוזר במודול הביקורת
      if (c.evidencePaths.length < 3 && !c.evidencePaths.includes(hit.path)) c.evidencePaths.push(hit.path);
    }
    // זיהוי משני מהנתיב — רק ראיה רכה
    const pathDetected = detectClaudeModels(hit.path).qualifying;
    for (const d of pathDetected) if (!c.textEvidence.includes(d.id)) c.textEvidence.push(d.id);
    if (!c.via.includes("code")) c.via.push("code");
  }

  for (const hit of repoHits) {
    const c = ensure(hit.fullName);
    c.stars = Math.max(c.stars, hit.stars);
    c.description = hit.description ?? c.description;
    c.pushedAt = hit.pushedAt ?? c.pushedAt;
    c.topics = Array.from(new Set([...c.topics, ...hit.topics]));
    if (!c.via.includes("repo")) c.via.push("repo");
    // אזכור בתיאור/topics — ראיה רכה בלבד, אף פעם לא hard
    const hay = [hit.fullName, hit.description ?? "", hit.topics.join(" ")].join(" ");
    const detected = detectClaudeModels(hay).qualifying;
    for (const d of detected) if (!c.textEvidence.includes(d.id)) c.textEvidence.push(d.id);
  }

  const candidates = Array.from(map.values());
  for (const c of candidates) {
    c.modelStrings = Array.from(new Set([...c.contentEvidence, ...c.textEvidence]));
    scoreCandidateInPlace(c);
  }

  // ראייה קשה קודמת תמיד, אחר כך ציון
  const evRank = { hard: 0, soft: 1, none: 2 } as const;
  candidates.sort((a, b) => evRank[a.evidence] - evRank[b.evidence] || b.score - a.score);
  return candidates;
}

/** חישוב הציון של מועמד — מקור יחיד.
 * בעבר הציון חושב פעם אחת ב-consolidate בלבד; enrichCandidates שינה את
 * stars אחר-כך ו"הדירוג מחדש אחרי העשרה" מיין לפי ציון ישן שחושב עם stars=0 —
 * מאגר 10K-כוכבים שהתגלה בחיפוש קוד דורג כ-0-כוכבים, וזה עיוות את ה-top-60,
 * האליטה ובחירת הכרייה. */
export function scoreCandidateInPlace(c: Candidate): void {
  const listScore = computeListScore({
    fullName: c.fullName,
    description: c.description,
    stars: c.stars,
    forks: 0,
    topics: c.topics,
    pushedAt: c.pushedAt ?? undefined,
  });
  const evidenceWeight = (id: string, hard: boolean) => {
    const m = QUALIFYING_MODELS.find((x) => x.id === id);
    const w = m ? m.weight / 10 : 12 / 10;
    return hard ? w : w * 0.4; // ראיה רכה שווה פחות מחצי
  };
  const modelEvidence =
    c.contentEvidence.reduce((s, id) => s + evidenceWeight(id, true), 0) +
    c.textEvidence.reduce((s, id) => s + evidenceWeight(id, false), 0);
  c.evidence = c.contentEvidence.length > 0 ? "hard" : c.via.includes("code") || c.textEvidence.length > 0 ? "soft" : "none";
  c.score = Math.round(
    modelEvidence * 6 + c.capabilityHits * 4 + listScore.score + Math.log10(c.stars + 1) * 4
  );
}

/** העשרה — מטא-דאטה אמיתית למועמדים המובילים.
 *  סבב 5: 30 קריאות REST + מרווחי 400ms ← 1-2 קריאות GraphQL (עלות 1 נקודה כל אחת).
 *  שלב ה-enrich בסריקה ירד מ-~10 שניות לפחות משנייה. */
export async function enrichCandidates(
  candidates: Candidate[],
  token: string | null,
  topN = 30
): Promise<number> {
  const targets = candidates.slice(0, topN);
  // רק מי שחסר לו כוכבים (נמצא רק דרך חיפוש-קוד — חיפוש המאגרים כבר הביא כוכבים)
  const needMeta = targets.filter((c) => c.stars === 0).map((c) => c.fullName);
  // "הועשרו" = קיבל מטא-דאטה מ-GraphQL בפועל. בעבר נספרו גם מי שכבר היה לו stars
  // מחיפוש המאגרים (לא נקרא בכלל עליהם) — והמספר הוזרם היישר לפרומפט התדריך.
  let enriched = 0;
  if (needMeta.length > 0) {
    const metaMap = await batchRepoMeta(needMeta, token);
    for (const c of targets) {
      const m = metaMap.get(c.fullName);
      if (m) {
        enriched++;
        if (m.stars > 0) c.stars = m.stars;
        c.defaultBranch = m.defaultBranch; // חוסך קריאת /repos לכל ריפו שייכרה
      }
    }
  }
  // חישוב מחדש של הציונים שהשתנו — בעבר המיון "אחרי העשרה" השתמש בציונים
  // שחושבו עם stars=0 (ראה scoreCandidateInPlace): 10K-כוכבים שהתגלה בקוד
  // דורג כ-0-כוכבים בכל הדירוגים במורד הזרם.
  for (const c of targets) scoreCandidateInPlace(c);
  const evRank = { hard: 0, soft: 1, none: 2 } as const;
  candidates.sort((a, b) => evRank[a.evidence] - evRank[b.evidence] || b.score - a.score);
  return enriched;
}

// ---------- כרייה ----------

export interface MinedRepoReport {
  repo: string;
  artifacts: number;
  newCount: number;
  updatedCount: number;
  skippedStubs: number;
  kinds: string[];
  error?: string;
}

/** שלב ג׳ — כריית top-N מאגרים טריים לתוך הספרייה */
const MINE_ATTEMPTS_KEY = "mineAttempts";

async function loadMineAttempts(): Promise<Record<string, number>> {
  try {
    const row = await db.setting.findUnique({ where: { key: MINE_ATTEMPTS_KEY } });
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export interface MinedBatchResult {
  reports: MinedRepoReport[];
  /** כמה ריפו דולגו כי כבר הוכחו ריקים בכריות קודמות (שקיפות מלאה ב-evidence) */
  emptySkipped: number;
}

export async function mineTopCandidates(
  candidates: Candidate[],
  token: string | null,
  maxRepos = 8,
  onProgress?: (done: number, total: number, report: MinedRepoReport) => Promise<void> | void
): Promise<MinedBatchResult> {
  const minedNames = new Set(
    (
      await db.dnaArtifact.findMany({
        select: { sourceRepo: true },
        distinct: ["sourceRepo"],
      })
    ).map((x) => x.sourceRepo)
  );
  // זיכרון כריות ריקות: ריפו שנכרה פעמיים והניב 0 ארטיפקטים לא נכרה שוב.
  // (בעבר: simonw/llm-anthropic נכרה ב-Gen5 וב-Gen6 והחזיר 0 שתי הפעמים —
  //  בזבוז מכסה + רושם מטעה של "3 מאגרים נכרו")
  const mineAttempts = await loadMineAttempts();
  let emptySkipped = 0;
  const fresh = candidates
    .filter((c) => {
      if (minedNames.has(c.fullName)) return false;
      if ((mineAttempts[c.fullName] ?? 0) >= 2) {
        emptySkipped++;
        return false;
      }
      // חוק הסף — כרייה רק לריפו שמוכיחים ראייה למודל מזכה או יכולות .claude אמתיות,
      // או שמקורם ארגון האליטה עצמו. מועמד סטרילי (אין ראייה, אין יכולות) לא מתגנב לספרייה.
      // (בעבר: ריפו עם 4.x בלבד וכוכבים נכרה לספריית ה-DNA)
      if (c.evidence === "hard") return true;
      if (c.capabilityHits > 0) return true;
      if (/^anthropics\//i.test(c.fullName)) return true;
      return false;
    })
    .slice(0, maxRepos);
  const reports: MinedRepoReport[] = [];

  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    // ענף ברירת המחדל מה-GraphQL של ההעשרה — חוסך קריאת /repos לכל ריפו
    const results = await Promise.allSettled(
      batch.map((c) => harvestRepo(c.fullName, token, { stars: c.stars, defaultBranch: c.defaultBranch ?? null }))
    );
    // await במקום void — כתיבות התקדמות לא-מסודרות יכלו להחזיר progress אחורה
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const c = batch[j];
      if (r.status === "fulfilled") {
        const v = r.value;
        const rep: MinedRepoReport = {
          repo: v.repo,
          artifacts: v.artifacts,
          newCount: v.newCount,
          updatedCount: v.updatedCount ?? 0,
          skippedStubs: v.skippedStubs ?? 0,
          kinds: v.kinds,
        };
        reports.push(rep);
        await onProgress?.(reports.length, fresh.length, rep);
      } else {
        const rep: MinedRepoReport = {
          repo: c.fullName,
          artifacts: 0,
          newCount: 0,
          updatedCount: 0,
          skippedStubs: 0,
          kinds: [],
          error: r.reason instanceof Error ? r.reason.message : "כרייה נכשלה",
        };
        reports.push(rep);
        await onProgress?.(reports.length, fresh.length, rep);
      }
    }
  }

  // עדכון זיכרון הכריות הריקות — שקיפות מלאה: המספר נרשם ב-evidence של השלב
  for (const rep of reports) {
    if (!rep.error && rep.artifacts === 0) mineAttempts[rep.repo] = (mineAttempts[rep.repo] ?? 0) + 1;
    else if (rep.artifacts > 0) delete mineAttempts[rep.repo];
  }
  try {
    await db.setting.upsert({
      where: { key: MINE_ATTEMPTS_KEY },
      update: { value: JSON.stringify(mineAttempts) },
      create: { key: MINE_ATTEMPTS_KEY, value: JSON.stringify(mineAttempts) },
    });
  } catch {
    // זיכרון הוא אופטימיזציה — כשל שמירה לא מפיל את השלב
  }

  return { reports, emptySkipped };
}

// ---------- דוח שטוח ללהקת הפרומפטים ----------

export interface CandidateFlat {
  fullName: string;
  stars: number;
  description: string | null;
  pushedAt: string | null;
  topics: string[];
  modelStrings: string[];
  /** מאומת: נמצא בתוכן קובץ אמיתי */
  contentEvidence: string[];
  /** רק אזכור בתיאור/topics/נתיב */
  textEvidence: string[];
  /** נתיבי קבצים אמיתיים לקרקע-אמת */
  evidencePaths: string[];
  capabilityHits: number;
  evidence: Candidate["evidence"];
  score: number;
  tier: TierKey;
  tierLabel: string;
}

export function flattenForSwarm(candidates: Candidate[]): CandidateFlat[] {
  return candidates.map((c) => {
    const t = tierOf(Math.min(100, c.score));
    return {
      fullName: c.fullName,
      stars: c.stars,
      description: c.description,
      pushedAt: c.pushedAt,
      topics: c.topics.slice(0, 8),
      modelStrings: c.modelStrings,
      contentEvidence: c.contentEvidence,
      textEvidence: c.textEvidence,
      evidencePaths: c.evidencePaths,
      capabilityHits: c.capabilityHits,
      evidence: c.evidence,
      score: c.score,
      tier: t.key,
      tierLabel: t.label,
    };
  });
}
