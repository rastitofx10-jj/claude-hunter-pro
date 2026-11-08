// ============================================================
// קוצר אוטונומי (Auto-Harvester) — הצינור שמחבר את הצייד לספרייה:
// חיפוש קוד 5.5+ ב-GitHub ← דירוג מאגרים עשירים בסקילים ← כריית DNA ← עדכון ספרייה
// לחיצה אחת ← הספרייה מתפוצצת בגנים אמיתיים מהאליטה העולמית.
// פועל בצד שרת בלבד.
// ============================================================

import { ghFetch } from "./github";
import { mineDna } from "./dna-miner";
import { db } from "./db";

const SEARCH_QUERIES = ["claude-opus-5-5", "claude-fable"]; // סמני 5.5+ בלבד

interface GhCodeItem {
  path: string;
  repository?: {
    full_name: string;
    stargazers_count?: number;
    pushed_at?: string;
    description?: string | null;
  };
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
}

interface Candidate {
  fullName: string;
  stars: number;
  skillRichness: number; // כמה מההתאמות הן קבצי יכולת (.claude/, SKILL.md, CLAUDE.md)
  alreadyMined: boolean;
}

/** גילוי מאגרי אליטה מחיפושי קוד 5.5+ ודירוג לפי עושר סקילים וכוכבים */
export async function discoverEliteRepos(token: string | null): Promise<Candidate[]> {
  const byName = new Map<string, Candidate>();

  for (const q of SEARCH_QUERIES) {
    try {
      const resp = await ghFetch<GhSearchResp>(
        `/search/code?q=${encodeURIComponent(q)}&per_page=100&page=1`,
        token
      );
      for (const item of resp.items ?? []) {
        const r = item.repository;
        if (!r?.full_name) continue;
        const existing = byName.get(r.full_name);
        const richnessGain = isCapabilityPath(item.path) ? 1 : 0;
        if (existing) {
          existing.skillRichness += richnessGain;
          existing.stars = Math.max(existing.stars, r.stargazers_count ?? 0);
        } else {
          byName.set(r.full_name, {
            fullName: r.full_name,
            stars: r.stargazers_count ?? 0,
            skillRichness: richnessGain,
            alreadyMined: false,
          });
        }
      }
    } catch {
      // חיפוש אחד נכשל — ממשיכים לשני
    }
  }

  const candidates = Array.from(byName.values());
  if (candidates.length === 0) return [];

  const minedNames = new Set(
    (await db.dnaArtifact.findMany({ select: { sourceRepo: true }, distinct: ["sourceRepo"] })).map(
      (x) => x.sourceRepo
    )
  );
  for (const c of candidates) c.alreadyMined = minedNames.has(c.fullName);

  // חיפוש קוד לא כולל כוכבים — מעשירים את 25 המועמדים המובילים בנתוני כוכבים אמיתיים
  const toEnrich = candidates.filter((c) => !c.alreadyMined).slice(0, 25);
  await Promise.allSettled(
    toEnrich.map(async (c) => {
      try {
        const meta = await ghFetch<{ stargazers_count: number }>(`/repos/${c.fullName}`, token);
        c.stars = meta.stargazers_count ?? 0;
      } catch {
        // נשאר עם 0 — לא קריטי
      }
    })
  );

  // דירוג: צירוף עושר-סקילים עם פופולריות — כך מאגרי הענק עולים ראשונים
  const score = (c: Candidate) => c.skillRichness * 5 + Math.log10(c.stars + 1) * 3;
  candidates.sort((a, b) => {
    if (a.alreadyMined !== b.alreadyMined) return a.alreadyMined ? 1 : -1;
    return score(b) - score(a);
  });
  return candidates;
}

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

/** כריית מאגר בודד + upsert לספרייה. מחזיר דוח. */
export async function harvestRepo(fullName: string, token: string | null): Promise<HarvestRepoReport & { updatedCount: number }> {
  const [owner, ...rest] = fullName.split("/");
  const repo = rest.join("/");
  if (!owner || !repo) throw new Error(`שם מאגר לא תקין: ${fullName}`);

  const pkg = await mineDna(owner, repo, token);

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

  for (const a of artifacts) {
    const existing = await db.dnaArtifact.findUnique({
      where: { sourceRepo_path: { sourceRepo: fullName, path: a.path } },
      select: { id: true, content: true },
    });
    if (existing) {
      if ((existing.content ?? "") !== (a.content ?? "")) {
        await db.dnaArtifact.update({
          where: { id: existing.id },
          data: {
            name: a.name,
            description: a.description,
            content: a.content,
            size: a.size,
          },
        });
        updatedCount++;
      }
    } else {
      await db.dnaArtifact.create({
        data: {
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
      newCount++;
    }
    kinds.add(a.kind);
  }

  return {
    repo: fullName,
    stars: 0, // ממולא על-ידי הקורא מהרשימה
    artifacts: pkg.artifacts.length,
    kinds: Array.from(kinds),
    newCount,
    updatedCount,
    skippedStubs,
  };
}

/**
 * הקציר המלא: גילוי ← בחירת top-N חדשים ← כרייה במקביל מרוסן ← דוח.
 */
export async function harvest(token: string | null, maxRepos = 6): Promise<HarvestResult> {
  const candidates = await discoverEliteRepos(token);
  const fresh = candidates.filter((c) => !c.alreadyMined).slice(0, maxRepos);
  const skippedAlreadyMined = candidates.filter((c) => c.alreadyMined).length;

  const starsMap = new Map(candidates.map((c) => [c.fullName, c.stars]));
  const reports: (HarvestRepoReport & { updatedCount: number })[] = [];

  // ריצה במקביל מרוסן (2 בכל פעם) — מהיר אך עדין למכסה
  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    const results = await Promise.allSettled(batch.map((c) => harvestRepo(c.fullName, token)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        reports.push({ ...r.value, stars: starsMap.get(r.value.repo) ?? 0 });
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
  };
}
