// ============================================================
// Deep sweep engine — Claude Hunter
// A full professional intelligence round: a wide query arsenal (code + repos)
// ← metadata enrichment ← evidence-based ranking ← DNA mining.
// This is the step from "two hardcoded queries" to a real arsenal that updates from the model registry.
// Runs server-side only.
// ============================================================

import { ghSearchWithBackoff, ghGraphql, computeListScore, tierOf, type TierKey, isCapabilityPath, getQuotaState } from "./github";
import { QUALIFYING_MODELS, detectClaudeModels } from "./claude-models";
import { harvestRepo, batchRepoMeta } from "./harvester";
import { db } from "./db";

// ---------- Query arsenal ----------

export interface SweepQuery {
  q: string;
  kind: "code" | "repo";
  /** Where the query comes from: registry (a registered model) | capability | topic | market */
  origin: string;
}

/** Builds the full query arsenal from the model registry — always in sync with the threshold */
export function buildQueryArsenal(): SweepQuery[] {
  const queries: SweepQuery[] = [];

  // 1. Every search string of every qualifying model — direct code search (the hard evidence)
  for (const m of QUALIFYING_MODELS) {
    for (const s of m.searchStrings) {
      queries.push({ q: s, kind: "code", origin: `registry:${m.id}` });
    }
  }

  // 2. Capability queries — Claude capability files with premium strings
  queries.push(
    { q: "SKILL.md claude", kind: "code", origin: "capability" },
    { q: "claude-code commands", kind: "code", origin: "capability" },
    { q: "claude agents orchestration", kind: "code", origin: "capability" },
    { q: "anthropic max tokens opus", kind: "code", origin: "capability" },
  );

  // 3. Repo searches — the broad market of active Claude projects
  // (120 days — previously misnamed monthAgo; the variable name misled everyone)
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

// ---------- Candidate discovery ----------

export interface CodeHit {
  path: string;
  repo: string;
  capability: boolean;
  /** The query that found the file — GitHub code search matches file content, so this proves the string is in the content */
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
  /** Proof: found inside a real file's content (GitHub code search matches content) — hard evidence */
  contentEvidence: string[];
  /** Default branch from GraphQL — saves a /repos call during mining */
  defaultBranch?: string | null;
  /** Found only in description/topics/path — soft evidence, not proof of use in code */
  textEvidence: string[];
  /** Real file paths where a registered model string was found — ground truth for re-verification */
  evidencePaths: string[];
  /** For display: the union of both sources */
  modelStrings: string[];
  /** How many capability files were discovered (SKILL.md, .claude/, etc.) */
  capabilityHits: number;
  /** Model-evidence precision: hard (model string in code content — verified) | soft (a mention in description/path) | none */
  evidence: "hard" | "soft" | "none";
  score: number;
  /** Discovery sources */
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
//  that ghFetch had already rewritten, so rate-limited queries were
//  thrown permanently instead of waiting 8s/16s/32s and retrying.)

/**
 * Stage A — firing all queries at a rate safe for the search quota (30/min),
 * with progress reporting after each query.
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
    // Quota-header pacing BEFORE the query fires: the previous response already
    // told us where we stand. With ≤3 points left we hold this query until the
    // window resets (up to 30s, on top of the normal inter-query sleep below) —
    // instead of charging ahead, eating the 403, and making ghSearchWithBackoff
    // recover it after the fact. remaining == null (no header ever seen) →
    // exactly the old blind-pacing behavior.
    const quota = getQuotaState();
    if (quota.remaining != null && quota.remaining <= 3 && quota.reset != null) {
      const extraMs = Math.min(30_000, Math.max(0, (quota.reset - Math.floor(Date.now() / 1000) + 1) * 1000));
      console.log(
        `[deep-sweep] quota low: ${quota.remaining} left${quota.resource ? ` (${quota.resource})` : ""} — holding ${Math.round(extraMs / 1000)}s for the window reset`
      );
      await sleep(extraMs);
    }
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
      report = { ...report, count: 0, error: e instanceof Error ? e.message : "error" };
    }
    reports.push(report);
    await onProgress(report, i + 1, queries.length);
    // Query-type-tailored pacing: code search gets a separate, stricter quota (10/min)
    // — 2.1s is enough for repositories but burns the code quota after ~10 queries.
    // (Before: 2.1s for everything → code queries got 403s and were recorded as errors)
    if (i < queries.length - 1) await sleep(query.kind === "code" ? 6_500 : 2_100);
  }

  return { reports, codeHits, repoHits };
}

/** Stage B — consolidating findings into evidence-ranked candidates, with strict source separation:
 *  — contentEvidence: GitHub code search matched the string inside a real file's content (verified)
 *  — textEvidence: the string appears only in description/topics/path (not proof of code)
 *  — evidence=hard if and only if there is contentEvidence. A description never gets promoted to "code". */
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

  // Query → registered model id mapping (by the arsenal origin)
  const queryToModel = new Map<string, string>();
  for (const m of QUALIFYING_MODELS) {
    for (const s of m.searchStrings) queryToModel.set(s.toLowerCase(), m.id);
  }

  for (const hit of codeHits) {
    const c = ensure(hit.repo);
    if (hit.capability) c.capabilityHits++;
    // Content proof only for a registered model string: the query was found in the file's content, but
    // capability/market queries (e.g. SKILL.md claude) are not proof of a model — only a soft signal.
    const asModel = queryToModel.get(hit.viaQuery.toLowerCase());
    if (asModel) {
      if (!c.contentEvidence.includes(asModel)) c.contentEvidence.push(asModel);
      // Saving the real file path — ground truth for re-verification in the audit module
      if (c.evidencePaths.length < 3 && !c.evidencePaths.includes(hit.path)) c.evidencePaths.push(hit.path);
    }
    // Secondary detection from the path — soft evidence only
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
    // A mention in description/topics — soft evidence only, never hard
    const hay = [hit.fullName, hit.description ?? "", hit.topics.join(" ")].join(" ");
    const detected = detectClaudeModels(hay).qualifying;
    for (const d of detected) if (!c.textEvidence.includes(d.id)) c.textEvidence.push(d.id);
  }

  const candidates = Array.from(map.values());
  for (const c of candidates) {
    c.modelStrings = Array.from(new Set([...c.contentEvidence, ...c.textEvidence]));
    scoreCandidateInPlace(c);
  }

  // Hard evidence always comes first, then score
  const evRank = { hard: 0, soft: 1, none: 2 } as const;
  candidates.sort((a, b) => evRank[a.evidence] - evRank[b.evidence] || b.score - a.score);
  return candidates;
}

/** Candidate score computation — single source.
 * Previously the score was computed only once in consolidate; enrichCandidates then changed
 * stars afterwards, and the "re-ranking after enrichment" sorted by a stale score computed with stars=0 —
 * a 10K-star repo discovered via code search was ranked as 0 stars, distorting the top-60,
 * the elite, and the mining selection. */
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
    return hard ? w : w * 0.4; // soft evidence is worth less than half
  };
  const modelEvidence =
    c.contentEvidence.reduce((s, id) => s + evidenceWeight(id, true), 0) +
    c.textEvidence.reduce((s, id) => s + evidenceWeight(id, false), 0);
  c.evidence = c.contentEvidence.length > 0 ? "hard" : c.via.includes("code") || c.textEvidence.length > 0 ? "soft" : "none";
  c.score = Math.round(
    modelEvidence * 6 + c.capabilityHits * 4 + listScore.score + Math.log10(c.stars + 1) * 4
  );
}

/** Enrichment — real metadata for the leading candidates.
 *  Round 5: 30 REST calls + 400ms gaps ← 1-2 GraphQL calls (costing 1 point each).
 *  The sweep's enrich stage dropped from ~10 seconds to under a second. */
export async function enrichCandidates(
  candidates: Candidate[],
  token: string | null,
  topN = 30
): Promise<number> {
  const targets = candidates.slice(0, topN);
  // Only those missing stars (found only via code search — the repo search already brought stars)
  const needMeta = targets.filter((c) => c.stars === 0).map((c) => c.fullName);
  // "Enriched" = actually received metadata from GraphQL. Before, those who already had stars
  // from the repo search were also counted (no call was made for them at all) — and the number was streamed straight into the briefing prompt.
  let enriched = 0;
  if (needMeta.length > 0) {
    const metaMap = await batchRepoMeta(needMeta, token);
    for (const c of targets) {
      const m = metaMap.get(c.fullName);
      if (m) {
        enriched++;
        if (m.stars > 0) c.stars = m.stars;
        c.defaultBranch = m.defaultBranch; // saves a /repos call for every repo that will be mined
      }
    }
  }
  // Recompute the changed scores — before, the "after enrichment" sort used scores
  // computed with stars=0 (see scoreCandidateInPlace): a 10K-star repo discovered via code
  // was ranked as 0 stars in every downstream ranking.
  for (const c of targets) scoreCandidateInPlace(c);
  const evRank = { hard: 0, soft: 1, none: 2 } as const;
  candidates.sort((a, b) => evRank[a.evidence] - evRank[b.evidence] || b.score - a.score);
  return enriched;
}

// ---------- Mining ----------

export interface MinedRepoReport {
  repo: string;
  artifacts: number;
  newCount: number;
  updatedCount: number;
  skippedStubs: number;
  kinds: string[];
  error?: string;
}

/** Stage C — mine the top-N fresh repos into the library */
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
  /** How many repos were skipped because they were already proven empty in previous mines (fully visible in evidence) */
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
  // Empty-mine memory: a repo mined twice that yielded 0 artifacts is not mined again.
  // (Before: simonw/llm-anthropic was mined in Gen5 and Gen6 and returned 0 both times —
  //  wasted quota + a misleading "3 repos mined" record)
  const mineAttempts = await loadMineAttempts();
  let emptySkipped = 0;
  const fresh = candidates
    .filter((c) => {
      if (minedNames.has(c.fullName)) return false;
      if ((mineAttempts[c.fullName] ?? 0) >= 2) {
        emptySkipped++;
        return false;
      }
      // Threshold rule — mine only repos that prove evidence of a qualifying model or real .claude capabilities,
      // or that originate from the elite organization itself. A sterile candidate (no evidence, no capabilities) doesn't sneak into the library.
      // (Before: a repo with only 4.x and stars was mined into the DNA library)
      if (c.evidence === "hard") return true;
      if (c.capabilityHits > 0) return true;
      if (/^anthropics\//i.test(c.fullName)) return true;
      return false;
    })
    .slice(0, maxRepos);
  const reports: MinedRepoReport[] = [];

  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    // The default branch from the enrichment GraphQL — saves a /repos call per repo
    const results = await Promise.allSettled(
      batch.map((c) => harvestRepo(c.fullName, token, { stars: c.stars, defaultBranch: c.defaultBranch ?? null }))
    );
    // await instead of void — unordered progress writes could report progress backwards
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
          error: r.reason instanceof Error ? r.reason.message : "mining failed",
        };
        reports.push(rep);
        await onProgress?.(reports.length, fresh.length, rep);
      }
    }
  }

  // Update the empty-mine memory — full transparency: the number is recorded in the stage evidence
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
    // The memory is an optimization — a save failure doesn't take down the stage
  }

  return { reports, emptySkipped };
}

// ---------- Flat report for the prompt swarm ----------

export interface CandidateFlat {
  fullName: string;
  stars: number;
  description: string | null;
  pushedAt: string | null;
  topics: string[];
  modelStrings: string[];
  /** Verified: found inside a real file's content */
  contentEvidence: string[];
  /** Only a mention in description/topics/path */
  textEvidence: string[];
  /** Real file paths for ground truth */
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
