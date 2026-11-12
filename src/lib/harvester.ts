// ============================================================
// Autonomous harvester (Auto-Harvester) — the pipeline connecting the hunter to the library:
// GitHub real-model code search ← ranking skill-rich repos ← DNA mining ← library update
// One click ← the library explodes with real genes from the global elite.
// Runs server-side only.
//
// Round 5 improvements (measured live):
// - Metadata enrichment: 25 REST calls ← a single GraphQL call (cost: 1 point)
// - Queries derived from the real model registry instead of 2 hardcoded —
//   3x wider coverage per harvest
// - Every failure is visible: a failed query / a repo that failed to mine — reported in the result,
//   nothing is silently swallowed (before: "harvest finished · 0 mined" with no explanation)
// - ghSearchWithBackoff for every code query — survived the 10/min quota instead of failing
// - mineDna receives the default branch from GraphQL ← saves an extra /repos call
//   for every mined repo
// ============================================================

import { ghFetch, ghSearchWithBackoff, ghGraphql, mapLimit, GhError, isCapabilityPath } from "./github";
import { QUALIFYING_MODELS } from "./claude-models";
import { mineDna } from "./dna-miner";
import { db } from "./db";
import { FRONTIER_CODE_POOL, rotateSlice, hydrateFresh, daySeed } from "./frontier-queries";
import { gateArtifacts, type QualityRejection } from "./quality-gate";
import { recordQueryYields } from "./adaptive-learning";
import { scanAndRecord } from "./emerging-models";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The harvest's discovery queries — 6 slots, rotated daily.
 *  2 registry (model strings, rotated by day) + 4 frontier (contract files / SDK /
 *  configs, rotated by day). Before: 6 fixed model strings — the same candidates
 *  every day, which is exactly why the harvest saturated (+0 genes by gen 8).
 *  Daily rotation makes each day's harvest probe different corners. */
function harvestQueries(): string[] {
  const seed = daySeed();
  const registry: string[] = [];
  for (const m of QUALIFYING_MODELS) {
    const primary = m.searchStrings.find((s) => /^claude-[a-z0-9-]+$/.test(s)) ?? m.searchStrings[0];
    if (primary && !registry.includes(primary)) registry.push(primary);
  }
  const regSlice = rotateSlice(registry, seed, 2).map((q) => q);
  const frontierSlice = rotateSlice(FRONTIER_CODE_POOL, seed * 3, 4).map((f) => hydrateFresh(f.q));
  const qs = [...regSlice, ...frontierSlice];
  return qs.slice(0, 6); // code-search quota 10/min — 6 queries with 6.5s spacing = safe
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
  /** Chimera quality gate (WO3): genes rejected at ingestion, with reasons */
  qualityRejected?: QualityRejection[];
  /** Average quality score of the genes that passed (0..1) */
  avgQuality?: number | null;
}

export interface HarvestResult {
  candidatesFound: number;
  reposMined: HarvestRepoReport[];
  artifactsAdded: number;
  artifactsUpdated: number;
  totalLibrary: number;
  fieldDna: number;
  skippedAlreadyMined: number;
  /** Genes rejected by the chimera quality gate across all mined repos */
  qualityRejectedTotal: number;
  /** Full transparency: what actually happened at the discovery stage */
  queriesRun: { q: string; count: number }[];
  queriesFailed: { q: string; error: string }[];
  /** Repos selected for mining that failed — with the reason (previously they vanished silently) */
  reposFailed: { repo: string; error: string }[];
}

/** Metadata from GraphQL: stars + default branch for every repo that might be mined */
interface RepoMeta {
  stars: number;
  defaultBranch: string | null;
  license: string | null;
}

interface Candidate {
  fullName: string;
  stars: number;
  skillRichness: number;
  alreadyMined: boolean;
  meta?: RepoMeta;
  /** The queries that surfaced this repo — feed for adaptive learning attribution */
  viaQueries: string[];
}

/**
 * Metadata enrichment in a single GraphQL call: up to 40 repos at once
 * (stars + default branch). Replaces 25-30 REST calls + wait gaps.
 * Cost: one point from the 5000/hour quota. Returns a fullName → meta map.
 */
export async function batchRepoMeta(
  fullNames: string[],
  token: string | null
): Promise<Map<string, RepoMeta>> {
  const out = new Map<string, RepoMeta>();
  if (fullNames.length === 0) return out;
  // Chunks of 40 — a safe size for an aliased query
  for (let i = 0; i < fullNames.length; i += 40) {
    const chunk = fullNames.slice(i, i + 40);
    const aliases = chunk
      .map((name, j) => {
        const [owner, repo] = name.split("/");
        if (!owner || !repo) return null;
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { stargazerCount defaultBranchRef { name } licenseInfo { spdxId } }`;
      })
      .filter(Boolean);
    if (aliases.length === 0) continue;
    try {
      const data = await ghGraphql<
        Record<string, { stargazerCount: number; defaultBranchRef: { name: string } | null; licenseInfo: { spdxId: string | null } | null } | null>
      >(`query { ${aliases.join(" ")} }`, token);
      chunk.forEach((name, j) => {
        const r = data?.[`r${j}`];
        if (r)
          out.set(name, {
            stars: r.stargazerCount ?? 0,
            defaultBranch: r.defaultBranchRef?.name ?? null,
            license: r.licenseInfo?.spdxId ?? null,
          });
      });
    } catch {
      // Enrichment is an optimization — a repo without meta is simply mined without exact stars
    }
  }
  return out;
}

/** Discover elite repos from real-model code searches and rank by skill richness and stars */
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
      // 8/16/32s backoff on the search quota — before, a direct ghFetch failed forever on 403
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
          if (!existing.viaQueries.includes(q)) existing.viaQueries.push(q);
        } else {
          byName.set(r.full_name, { fullName: r.full_name, stars: 0, skillRichness: richnessGain, alreadyMined: false, viaQueries: [q] });
        }
      }
    } catch (e) {
      queriesFailed.push({ q, error: e instanceof Error ? e.message : "error" });
    }
    if (i < queries.length - 1) await sleep(6_500); // code-search quota: 10/min
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

  // Preliminary ranking (without stars): skill richness first — the strongest marker for DNA
  candidates.sort((a, b) => b.skillRichness - a.skillRichness);

  // GraphQL enrichment: only those with a chance of being mined (fresh first) — not a blind 25
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

  // Final ranking: combining skill richness with popularity — that way the giant repos surface first
  const score = (c: Candidate) => c.skillRichness * 5 + Math.log10(c.stars + 1) * 3;
  candidates.sort((a, b) => {
    if (a.alreadyMined !== b.alreadyMined) return a.alreadyMined ? 1 : -1;
    return score(b) - score(a);
  });
  return { candidates, queriesRun, queriesFailed };
}

/** Mine a single repo + upsert into the library. Returns a report. */
export async function harvestRepo(
  fullName: string,
  token: string | null,
  pre?: RepoMeta
): Promise<HarvestRepoReport & { updatedCount: number }> {
  const [owner, ...rest] = fullName.split("/");
  const repo = rest.join("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${fullName}`);

  // The branch from the discovery GraphQL saves an extra /repos call per repo
  const pkg = await mineDna(owner, repo, token, { defaultBranch: pre?.defaultBranch });

  let newCount = 0;
  let updatedCount = 0;
  const kinds = new Set<string>();

  // Chimera quality gate (WO3) — replaces the raw byte-floor filter: a stub gene
  // never enters the library, and now neither does structure-less fluff or a
  // generic-name placeholder. Every rejection is reported with its reasons.
  const { kept: artifacts, rejected, avgScore } = gateArtifacts(pkg.artifacts);
  const skippedStubs = rejected.filter((r) => r.reasons.some((x) => x.startsWith("stub:"))).length;
  const qualityRejected = rejected.slice(0, 6);

  // A single fetch of the repo's existing rows (instead of findUnique per artifact — N+1).
  // Used both for a reliable "new vs updated" count and for skipping identical writes.
  const existingRows = await db.dnaArtifact.findMany({
    where: { sourceRepo: fullName },
    select: { path: true, content: true },
  });
  const existingByPath = new Map(existingRows.map((r) => [r.path, r.content]));

  for (const a of artifacts) {
    const prev = existingByPath.get(a.path);
    if (prev !== undefined && prev === (a.content ?? "")) {
      kinds.add(a.kind); // exists and identical — untouched, not counted as an update
      continue;
    }
    // Atomic upsert on the composite key (before: findUnique+update/create — a race window)
    await db.dnaArtifact.upsert({
      where: { sourceRepo_path: { sourceRepo: fullName, path: a.path } },
      update: {
        name: a.name,
        description: a.description,
        content: a.content,
        size: a.size,
        // license flows in whenever meta is available — gradual backfill for old genes too
        ...(pre?.license ? { license: pre.license } : {}),
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
        license: pre?.license ?? null,
      },
    });
    if (prev === undefined) newCount++;
    else updatedCount++;
    kinds.add(a.kind);
  }

  // Frontier radar feed — the mined files are the richest text the hunter ever
  // touches (full SKILL.md / CLAUDE.md / settings content). Every gene mined is a
  // chance to notice the next frontier version the registry doesn't know yet.
  // Attribution is exact: repo + the real file path. Never blocks the harvest.
  try {
    for (const a of artifacts) {
      if (a.content) await scanAndRecord(a.content, fullName, a.path);
    }
  } catch { /* radar must never stall the harvest */ }

  return {
    repo: fullName,
    stars: pre?.stars ?? 0,
    artifacts: pkg.artifacts.length,
    kinds: Array.from(kinds),
    newCount,
    updatedCount,
    skippedStubs,
    qualityRejected,
    avgQuality: avgScore,
  };
}

/**
 * The full harvest: discovery ← top-N fresh selection ← throttled parallel mining ← report.
 * Nothing is swallowed: failed queries, failed repos — all in the report.
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

  // Throttled parallel run (2 at a time) — fast yet gentle on the quota
  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    const results = await Promise.allSettled(
      batch.map((c) =>
        harvestRepo(c.fullName, token, {
          stars: c.stars,
          defaultBranch: c.meta?.defaultBranch ?? null,
          license: c.meta?.license ?? null,
        })
      )
    );
    results.forEach((r, j) => {
      const c = batch[j];
      if (r.status === "fulfilled") {
        reports.push({ ...r.value, stars: r.value.stars || c.stars });
      } else {
        // Before: a rejection vanished silently and the user saw "0 mined" with no reason
        reposFailed.push({ repo: c.fullName, error: r.reason instanceof Error ? r.reason.message : "mining failed" });
      }
    });
  }

  const [totalLibrary, fieldDna] = await Promise.all([
    db.dnaArtifact.count(),
    db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
  ]);

  // Adaptive learning (WO4) — attribute added genes to the queries that surfaced
  // the mined repos, so future harvests rank proven queries higher.
  const attribution: Record<string, number> = {};
  for (const rep of reports) {
    if (rep.newCount > 0) {
      const c = starsMap.get(rep.repo);
      for (const q of c?.viaQueries ?? []) attribution[q] = (attribution[q] ?? 0) + rep.newCount;
    }
  }
  await recordQueryYields(attribution);

  return {
    candidatesFound: candidates.length,
    reposMined: reports,
    artifactsAdded: reports.reduce((s, r) => s + r.newCount, 0),
    artifactsUpdated: reports.reduce((s, r) => s + ("updatedCount" in r ? r.updatedCount : 0), 0),
    totalLibrary,
    fieldDna,
    skippedAlreadyMined,
    qualityRejectedTotal: reports.reduce((s, r) => s + (r.qualityRejected?.length ?? 0), 0),
    queriesRun,
    queriesFailed,
    reposFailed,
  };
}

/** re-export for convenience when called from sweep — the GitHub error type for quota detection */
export { GhError };
