// ============================================================
// קוצר אוטונומי (Auto-Harvester) — הצינור שמחבר את הצייד לספרייה:
// חיפוש קוד 5.5+ ב-GitHub ← דירוג מאגרים עשירים בסקילים ← כריית DNA ← עדכון ספרייה
// לחיצה אחת ← הספרייה מתפוצצת בגנים אמיתיים מהאליטה העולמית.
// פועל בצד שרת בלבד.
//
// שיפורי סבב 5 (נמדדו חי):
// - העשרת מטא-דאטה: 25 קריאות REST ← קריאת GraphQL אחת (עלות 1 נקודה)
// - השאילתות נגזרות מרישום המודלים (6 מזהי 5.5+) במקום 2 קבועות —
//   כיסוי רחב פי 3 לכל קציר
// - כל כישלון נראה: שאילתה שנפלה / ריפו שנכשל בכרייה — מדווחים בתוצאה,
//   אף לא נבלע בשקט (בעבר: "הקציר הסתיים · נכרו 0" בלי הסבר)
// - ghSearchWithBackoff לכל שאילתת קוד — שרד מכסת 10/דקה במקום ליפול
// - mineDna מקבל את הענף ברירת המחדל מה-GraphQL ← חוסך קריאת /repos נוספת
//   לכל ריפו שנכרה
// ============================================================

import { ghFetch, ghSearchWithBackoff, ghGraphql, mapLimit, GhError, isCapabilityPath } from "./github";
import { QUALIFYING_MODELS } from "./claude-models";
import { mineDna } from "./dna-miner";
import { db } from "./db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** מזהה החיפוש המדויק ביותר של כל מודל מזכה (kebab-case — מה שמופיע בקוד אמיתי).
 *  נגזר מהרישום, לא מקודד ידנית — סף חדש ברישום = כיסוי אוטומטי בקציר. */
function harvestQueries(): string[] {
  const qs: string[] = [];
  for (const m of QUALIFYING_MODELS) {
    const primary = m.searchStrings.find((s) => /^claude-[a-z0-9-]+$/.test(s)) ?? m.searchStrings[0];
    if (primary && !qs.includes(primary)) qs.push(primary);
  }
  return qs.slice(0, 6); // מכסת חיפוש-קוד 10/דקה — 6 שאילתות עם ריווח 6.5s = בטוח
}

interface GhCodeItem {
  path: string;
  repository?: { full_name: string };
}

interface GhSearchResp {
  total_count: number;
  items: GhCodeItem[];
}

export interface HarvestRepoReport {
  repo: string;
  stars: number;
  artifacts: number;
  kinds: string[];
  newCount: number;
  updatedCount?: number;
  skippedStubs?: number;
}

export interface HarvestResult {
  candidatesFound: number;
  reposMined: HarvestRepoReport[];
  artifactsAdded: number;
  artifactsUpdated: number;
  totalLibrary: number;
  fieldDna: number;
  skippedAlreadyMined: number;
  /** שקיפות מלאה: מה באמת קרה בשלב הגילוי */
  queriesRun: { q: string; count: number }[];
  queriesFailed: { q: string; error: string }[];
  /** ריפואים שנבחרו לכרייה ונכשלו — עם הסיבה (בעבר נעלמו בשקט) */
  reposFailed: { repo: string; error: string }[];
}

/** מטא-דאטה מה-GraphQL: כוכבים + ענף ברירת מחדל לכל ריפו שייתכן שנכרה */
interface RepoMeta {
  stars: number;
  defaultBranch: string | null;
}

interface Candidate {
  fullName: string;
  stars: number;
  skillRichness: number;
  alreadyMined: boolean;
  meta?: RepoMeta;
}

/**
 * העשרת מטא-דאטה בקריאת GraphQL אחת: עד 40 ריפואים בבת אחת
 * (כוכבים + ענף ברירת מחדל). מחליף 25-30 קריאות REST + מרווחי המתנה.
 * עלות: נקודה אחת ממכסת 5000/שעה. מחזיר מפה fullName → מטא.
 */
export async function batchRepoMeta(
  fullNames: string[],
  token: string | null
): Promise<Map<string, RepoMeta>> {
  const out = new Map<string, RepoMeta>();
  if (fullNames.length === 0) return out;
  // מקטעים של 40 — גודל בטוח לשאילתת aliases
  for (let i = 0; i < fullNames.length; i += 40) {
    const chunk = fullNames.slice(i, i + 40);
    const aliases = chunk
      .map((name, j) => {
        const [owner, repo] = name.split("/");
        if (!owner || !repo) return null;
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { stargazerCount defaultBranchRef { name } }`;
      })
      .filter(Boolean);
    if (aliases.length === 0) continue;
    try {
      const data = await ghGraphql<Record<string, { stargazerCount: number; defaultBranchRef: { name: string } | null } | null>>(
        `query { ${aliases.join(" ")} }`,
        token
      );
      chunk.forEach((name, j) => {
        const r = data?.[`r${j}`];
        if (r) out.set(name, { stars: r.stargazerCount ?? 0, defaultBranch: r.defaultBranchRef?.name ?? null });
      });
    } catch {
      // העשרה היא אופטימיזציה — ריפו בלי מטא פשוט נכרה בלי כוכבים מדויקים
    }
  }
  return out;
}

/** גילוי מאגרי אליטה מחיפושי קוד 5.5+ ודירוג לפי עושר סקילים וכוכבים */
export async function discoverEliteRepos(
  token: string | null,
  opts?: { enrichCount?: number }
): Promise<{ candidates: Candidate[]; queriesRun: { q: string; count: number }[]; queriesFailed: { q: string; error: string }[] }> {
  const byName = new Map<string, Candidate>();
  const queriesRun: { q: string; count: number }[] = [];
  const queriesFailed: { q: string; error: string }[] = [];
  const queries = harvestQueries();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      // backoff 8/16/32s על מכסת חיפוש — בעבר ghFetch ישיר נפל לנצח על 403
      const resp = await ghSearchWithBackoff<GhSearchResp>(
        `/search/code?q=${encodeURIComponent(q)}&per_page=100&page=1`,
        token
      );
      queriesRun.push({ q, count: resp.total_count ?? 0 });
      for (const item of resp.items ?? []) {
        const r = item.repository;
        if (!r?.full_name) continue;
        const richnessGain = isCapabilityPath(item.path) ? 1 : 0;
        const existing = byName.get(r.full_name);
        if (existing) {
          existing.skillRichness += richnessGain;
        } else {
          byName.set(r.full_name, { fullName: r.full_name, stars: 0, skillRichness: richnessGain, alreadyMined: false });
        }
      }
    } catch (e) {
      queriesFailed.push({ q, error: e instanceof Error ? e.message : "שגיאה" });
    }
    if (i < queries.length - 1) await sleep(6_500); // מכסת חיפוש-קוד: 10/דקה
  }

  const candidates = Array.from(byName.values());
  if (candidates.length === 0) {
    return { candidates, queriesRun, queriesFailed };
  }

  const minedNames = new Set(
    (await db.dnaArtifact.findMany({ select: { sourceRepo: true }, distinct: ["sourceRepo"] })).map(
      (x) => x.sourceRepo
    )
  );
  for (const c of candidates) c.alreadyMined = minedNames.has(c.fullName);

  // דירוג מקדים (בלי כוכבים): עושר-סקילים קודם — זה הסמן החזק ביותר ל-DNA
  candidates.sort((a, b) => b.skillRichness - a.skillRichness);

  // העשרה ב-GraphQL: רק מי שיש סיכוי שנכרה (fresh ראשונים) — לא 25 עיוורים
  const freshSorted = candidates.filter((c) => !c.alreadyMined);
  const enrichCount = Math.min(opts?.enrichCount ?? 12, freshSorted.length);
  const toEnrich = freshSorted.slice(0, enrichCount).map((c) => c.fullName);
  const metaMap = await batchRepoMeta(toEnrich, token);
  for (const c of candidates) {
    const m = metaMap.get(c.fullName);
    if (m) {
      c.stars = m.stars;
      c.meta = m;
    }
  }

  // דירוג סופי: צירוף עושר-סקילים עם פופולריות — כך מאגרי הענק עולים ראשונים
  const score = (c: Candidate) => c.skillRichness * 5 + Math.log10(c.stars + 1) * 3;
  candidates.sort((a, b) => {
    if (a.alreadyMined !== b.alreadyMined) return a.alreadyMined ? 1 : -1;
    return score(b) - score(a);
  });
  return { candidates, queriesRun, queriesFailed };
}

/** כריית מאגר בודד + upsert לספרייה. מחזיר דוח. */
export async function harvestRepo(
  fullName: string,
  token: string | null,
  pre?: RepoMeta
): Promise<HarvestRepoReport & { updatedCount: number }> {
  const [owner, ...rest] = fullName.split("/");
  const repo = rest.join("/");
  if (!owner || !repo) throw new Error(`שם מאגר לא תקין: ${fullName}`);

  // הענף מה-GraphQL של הגילוי חוסך קריאת /repos נוספת לכל ריפו
  const pkg = await mineDna(owner, repo, token, { defaultBranch: pre?.defaultBranch });

  let newCount = 0;
  let updatedCount = 0;
  let skippedStubs = 0;
  const kinds = new Set<string>();

  // שער איכות — גן סתם (תוכן קצר מ-200 בייטים) לא נכנס לספרייה.
  // (בעבר: DNA #133 נכנס עם 11 בייטים — CLAUDE.md ריק נחשב "גן")
  const MIN_GENE_BYTES = 200;
  const artifacts = pkg.artifacts.filter((a) => {
    if ((a.content ?? "").length >= MIN_GENE_BYTES) return true;
    skippedStubs++;
    return false;
  });

  // שליפה אחת של השורות הקיימות לריפו (במקום findUnique לכל ארטיפקט — N+1).
  // משמשת גם לספירה אמינה של "חדש מול עודכן" וגם לדילוג על כתיבות זהות.
  const existingRows = await db.dnaArtifact.findMany({
    where: { sourceRepo: fullName },
    select: { path: true, content: true },
  });
  const existingByPath = new Map(existingRows.map((r) => [r.path, r.content]));

  for (const a of artifacts) {
    const prev = existingByPath.get(a.path);
    if (prev !== undefined && prev === (a.content ?? "")) {
      kinds.add(a.kind); // קיים וזהה — לא נוגעים, לא נספר כעדכון
      continue;
    }
    // upsert אטומי על המפתח המורכב (בעבר: findUnique+update/create — חלון מרוץ)
    await db.dnaArtifact.upsert({
      where: { sourceRepo_path: { sourceRepo: fullName, path: a.path } },
      update: {
        name: a.name,
        description: a.description,
        content: a.content,
        size: a.size,
      },
      create: {
        sourceRepo: fullName,
        path: a.path,
        kind: a.kind,
        name: a.name,
        description: a.description,
        content: a.content,
        rawUrl: a.rawUrl,
        size: a.size,
      },
    });
    if (prev === undefined) newCount++;
    else updatedCount++;
    kinds.add(a.kind);
  }

  return {
    repo: fullName,
    stars: pre?.stars ?? 0,
    artifacts: pkg.artifacts.length,
    kinds: Array.from(kinds),
    newCount,
    updatedCount,
    skippedStubs,
  };
}

/**
 * הקציר המלא: גילוי ← בחירת top-N חדשים ← כרייה במקביל מרוסן ← דוח.
 * שום דבר לא נבלע: שאילתות שנפלו, ריפואים שנכשלו — הכל בדוח.
 */
export async function harvest(token: string | null, maxRepos = 6): Promise<HarvestResult> {
  const { candidates, queriesRun, queriesFailed } = await discoverEliteRepos(token, {
    enrichCount: Math.min(12, maxRepos + 6),
  });
  const fresh = candidates.filter((c) => !c.alreadyMined).slice(0, maxRepos);
  const skippedAlreadyMined = candidates.filter((c) => c.alreadyMined).length;

  const starsMap = new Map(candidates.map((c) => [c.fullName, c]));
  const reports: (HarvestRepoReport & { updatedCount: number })[] = [];
  const reposFailed: { repo: string; error: string }[] = [];

  // ריצה במקביל מרוסן (2 בכל פעם) — מהיר אך עדין למכסה
  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    const results = await Promise.allSettled(
      batch.map((c) => harvestRepo(c.fullName, token, { stars: c.stars, defaultBranch: c.meta?.defaultBranch ?? null }))
    );
    results.forEach((r, j) => {
      const c = batch[j];
      if (r.status === "fulfilled") {
        reports.push({ ...r.value, stars: r.value.stars || c.stars });
      } else {
        // בעבר: דחייה נעלמה בשקט והמשתמש ראה "נכרו 0" בלי סיבה
        reposFailed.push({ repo: c.fullName, error: r.reason instanceof Error ? r.reason.message : "כרייה נכשלה" });
      }
    });
  }

  const [totalLibrary, fieldDna] = await Promise.all([
    db.dnaArtifact.count(),
    db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
  ]);

  return {
    candidatesFound: candidates.length,
    reposMined: reports,
    artifactsAdded: reports.reduce((s, r) => s + r.newCount, 0),
    artifactsUpdated: reports.reduce((s, r) => s + ("updatedCount" in r ? r.updatedCount : 0), 0),
    totalLibrary,
    fieldDna,
    skippedAlreadyMined,
    queriesRun,
    queriesFailed,
    reposFailed,
  };
}

/** re-export לנוחות הקריאה מ-sweep — טיפוס השגיאה של GitHub לזיהוי מכסה */
export { GhError };
