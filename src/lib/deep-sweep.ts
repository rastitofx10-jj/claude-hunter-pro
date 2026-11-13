// ============================================================
// Deep sweep engine — Claude Hunter
// A full professional intelligence round: a wide query arsenal (code + repos)
// ← metadata enrichment ← evidence-based ranking ← DNA mining.
// This is the step from "two hardcoded queries" to a real arsenal that updates from the model registry.
// Runs server-side only.
// ============================================================

import { ghSearchWithBackoff, ghGraphql, computeListScore, tierOf, type TierKey, isCapabilityPath, getQuotaState } from "./github";
import { QUALIFYING_MODELS, frontierModels, detectClaudeModels } from "./claude-models";
import { harvestRepo, batchRepoMeta } from "./harvester";
import { db } from "./db";
import { FRONTIER_CODE_POOL, FRONTIER_REPO_POOL, FRONTIER_MODEL_POOL, rotateSlice, hydrateFresh } from "./frontier-queries";
import { recordQueryYields } from "./adaptive-learning";
import { loadFrontierLedger, emergingModelQueries, promoteWithAuthority } from "./emerging-models";
import type { QualityRejection } from "./quality-gate";

// ---------- Query arsenal ----------

export interface SweepQuery {
  q: string;
  kind: "code" | "repo";
  /** Where the query comes from: registry (a registered model) | capability | topic | market */
  origin: string;
}

/**
 * Builds the full query arsenal from the model registry — always in sync with the threshold.
 * `seed` rotates the frontier slice: each generation/sweep probes different frontier
 * coordinates, so coverage compounds across runs instead of repeating (anti-saturation).
 */
export function buildQueryArsenal(seed = 0): SweepQuery[] {
  const queries: SweepQuery[] = [];

  // 1. Frontier registry queries — DEVICE DIRECTIVE (2026-11-13): only models AT
  //    each family's real frontier generate hunt queries (Opus 4.5 / Sonnet 4.5 /
  //    Haiku 4.5 today). The 9 older registry models burned 20 of 72 queries per
  //    sweep on historically-fixed corners; they still DETECT and SCORE in found
  //    repos, but never steer the hunt budget. frontierModels() tracks the
  //    registry automatically when a genuinely new real version lands.
  for (const m of frontierModels()) {
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
  // TRUTH-FIX: used to search "claude opus 5.5" / "claude fable" — fictional models,
  // zero real results beyond spam. Now searches the real frontier strings.
  const freshSince = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  queries.push(
    { q: `claude opus 4.5 stars:>5 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `claude sonnet 4.5 stars:>3 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `claude code agent stars:>100 pushed:>${freshSince}`, kind: "repo", origin: "market" },
    { q: `topic:claude-code stars:>30`, kind: "repo", origin: "topic" },
    { q: `topic:claude-agents stars:>10`, kind: "repo", origin: "topic" },
    { q: `topic:mcp topic:claude stars:>10`, kind: "repo", origin: "topic" },
    { q: `anthropic premium api integration stars:>20 pushed:>${freshSince}`, kind: "repo", origin: "market" },
  );

  // 4. Frontier — coordinates the arsenal never touched before (contract files,
  //    Agent SDK, MCP configs, young repos, fresh topics, awesome lists).
  //    A rotating slice of pools larger than the slice: cross-run novelty.
  //    (Field evidence: gens 6→9 collapsed +57→+9→+3→+1 probing the same corners.)
  for (const f of rotateSlice(FRONTIER_CODE_POOL, seed * 3, 6)) {
    queries.push({ q: f.q, kind: "code", origin: "frontier" });
  }
  for (const f of rotateSlice(FRONTIER_REPO_POOL, seed * 2, 3)) {
    queries.push({ q: hydrateFresh(f.q), kind: "repo", origin: "frontier" });
  }
  // Model frontier — the REAL frontier strings (opus 4.5 / sonnet 4.5 pins) plus
  // authority-confirmed future waves. Rotates like the others: a 3-query slice per sweep,
  // full pool covered across runs.
  for (const f of rotateSlice(FRONTIER_MODEL_POOL, seed * 5, 3)) {
    queries.push({ q: hydrateFresh(f.q), kind: f.kind, origin: "frontier-model" });
  }

  return queries;
}

/**
 * The adaptive arsenal — the static build PLUS the live frontier wave from the
 * emerging-model ledger. TRUTH-FIX: only AUTHORITY-CONFIRMED entries (org:anthropics
 * hit) join the arsenal — vouched-but-unverified entries steer nothing. This is also
 * the authority promotion point: before reading the ledger, vouched entries get their
 * org:anthropics check, so a real release confirmed this minute hunts this sweep.
 * Origin format: frontier-emerging:<ledgerEntryId> — startsWith("frontier"), so
 * every frontier-category consumer picks it up uniformly.
 */
export async function buildAdaptiveArsenal(seed = 0): Promise<SweepQuery[]> {
  const base = buildQueryArsenal(seed);
  try {
    const tokenRow = await db.setting.findUnique({ where: { key: "github_pat" } });
    await promoteWithAuthority(tokenRow?.value ?? null);
    const ledger = await loadFrontierLedger();
    for (const w of emergingModelQueries(ledger)) {
      base.push({ q: hydrateFresh(w.q), kind: w.kind, origin: `frontier-emerging:${w.entryId}` });
    }
  } catch {
    // ledger unavailable — the static arsenal still stands (the radar is an instrument, not a wall)
  }
  return base;
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
  /** The repo-search query that surfaced it — frontier identification in consolidation */
  viaQuery: string;
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
  /** Found by a frontier query (SDK import in content / curated repo-search) — ecosystem evidence */
  frontierHits: number;
  /** The queries that surfaced this repo — adaptive-learning attribution feed (WO4) */
  viaQueries: string[];
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
            viaQuery: query.q,
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
 *  — evidence=hard if and only if there is contentEvidence. A description never gets promoted to "code".
 *  dynamicModelQueries: hydrated query strings from the emerging-model wave that ran this sweep —
 *  a hit via one of them is hard evidence for the model family it names (same content-match
 *  guarantee as the static frontier-model pool), and counts as a frontier hit. */
export function consolidateCandidates(
  codeHits: CodeHit[],
  repoHits: RepoHit[],
  dynamicModelQueries: string[] = []
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
        frontierHits: 0,
        viaQueries: [],
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
  // Frontier-model queries carry their own model proof: GitHub code search matches
  // the model phrase INSIDE the file's content (`opus 4.5 filename:CLAUDE.md` only
  // returns files whose content contains the phrase) — so a hit is hard evidence for
  // the models named in the query itself. AND-queries ("claude-sonnet-4-5" "claude-opus-4-5")
  // grant evidence for every model they name; the file had to contain all of them.
  const frontierModelEvidence = new Map<string, string[]>();
  for (const f of FRONTIER_MODEL_POOL) {
    if (f.kind !== "code") continue;
    const hq = hydrateFresh(f.q).toLowerCase();
    // Real registry ids only: the pool hunts the real frontier, and detectClaudeModels
    // classifies exactly the registered ids as qualifying.
    const ids = detectClaudeModels(f.q).qualifying.map((m) => m.id);
    if (ids.length > 0) frontierModelEvidence.set(hq, ids);
  }
  // Emerging-model wave (authority-confirmed frontier radar): the query names a
  // version ABOVE the real registry — detectClaudeModels classifies those as FICTION
  // (correctly: unverified by the gate). But these queries exist only for entries the
  // AUTHORITY gate confirmed (org:anthropics hit) — so the fiction-classified id in
  // the query IS the confirmed model id, and it earns hard evidence at the honest
  // 12-point fallback weight (unregistered, real, confirmed).
  for (const dq of dynamicModelQueries) {
    const hq = hydrateFresh(dq).toLowerCase();
    if (frontierModelEvidence.has(hq)) continue;
    const ids = detectClaudeModels(dq).fiction.map((f) => f.id).filter((id) => id !== "claude-fable");
    if (ids.length > 0) frontierModelEvidence.set(hq, ids);
  }
  // Frontier queries (hydrated to their runtime form) — a hit via one of them is
  // ecosystem evidence of its own: SDK imports, MCP configs, hooks contracts,
  // curated topics/awesome lists.
  const frontierQs = new Set<string>([
    ...FRONTIER_CODE_POOL.map((f) => f.q.toLowerCase()),
    ...FRONTIER_REPO_POOL.map((f) => hydrateFresh(f.q).toLowerCase()),
    ...FRONTIER_MODEL_POOL.map((f) => hydrateFresh(f.q).toLowerCase()),
    ...dynamicModelQueries.map((q) => hydrateFresh(q).toLowerCase()),
  ]);

  for (const hit of codeHits) {
    const c = ensure(hit.repo);
    if (hit.capability) c.capabilityHits++;
    if (frontierQs.has(hit.viaQuery.toLowerCase())) c.frontierHits++;
    // Adaptive-learning feed: remember which query surfaced this repo
    if (c.viaQueries.length < 8 && !c.viaQueries.includes(hit.viaQuery)) c.viaQueries.push(hit.viaQuery);
    // Content proof only for a registered model string: the query was found in the file's content, but
    // capability/market queries (e.g. SKILL.md claude) are not proof of a model — only a soft signal.
    const asModel = queryToModel.get(hit.viaQuery.toLowerCase());
    // Frontier-model fallback: the query itself names the model(s) — same content-match
    // guarantee as a registry query, so the same hard-evidence treatment.
    // (renamed 2026-11-13: the local used to be called `frontierModels`, shadowing
    // the imported frontierModels() selector added with the device directive)
    const waveProofModels = asModel ? [] : frontierModelEvidence.get(hit.viaQuery.toLowerCase()) ?? [];
    if (asModel || waveProofModels.length > 0) {
      const ids = asModel ? [asModel] : waveProofModels;
      for (const id of ids) if (!c.contentEvidence.includes(id)) c.contentEvidence.push(id);
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
    if (frontierQs.has(hit.viaQuery.toLowerCase())) c.frontierHits++;
    if (c.viaQueries.length < 8 && !c.viaQueries.includes(hit.viaQuery)) c.viaQueries.push(hit.viaQuery);
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
    modelEvidence * 6 + c.capabilityHits * 4 + c.frontierHits * 3 + listScore.score + Math.log10(c.stars + 1) * 4
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
  /** Chimera quality gate (WO3): genes rejected at ingestion, with reasons */
  qualityRejected?: QualityRejection[];
  /** Average quality score of the genes that passed (0..1) */
  avgQuality?: number | null;
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
  /** Adaptive learning (WO4): query → genes it contributed this run — persisted for future ranking */
  queryAttribution: Record<string, number>;
}

export async function mineTopCandidates(
  candidates: Candidate[],
  token: string | null,
  maxRepos = 8,
  onProgress?: (done: number, total: number, report: MinedRepoReport) => Promise<void> | void,
  executedQueries: string[] = []
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
      // Threshold rule — mine only repos that prove ecosystem evidence: a qualifying
      // model in code, real .claude capabilities, a frontier hit (SDK import in content,
      // curated topic/awesome list), or the elite organization itself.
      // A sterile candidate (no evidence, no capabilities) doesn't sneak into the library.
      // (Before: a repo with only 4.x and stars was mined into the DNA library)
      if (c.evidence === "hard") return true;
      if (c.capabilityHits > 0) return true;
      if (c.frontierHits > 0) return true;
      if (/^anthropics\//i.test(c.fullName)) return true;
      return false;
    })
    .slice(0, maxRepos);
  const reports: MinedRepoReport[] = [];

  // License at birth — mandatory provenance for every gene: without a known
  // license there is no lawful commercial distribution of derivatives.
  // One batched GraphQL call for the whole list (1 point per 40 repos) — zero REST cost.
  const licMeta = await batchRepoMeta(
    fresh.map((c) => c.fullName),
    token
  ).catch(
    () => new Map<string, { stars: number; defaultBranch: string | null; license: string | null }>()
  );

  for (let i = 0; i < fresh.length; i += 2) {
    const batch = fresh.slice(i, i + 2);
    // The default branch from the enrichment GraphQL — saves a /repos call per repo
    const results = await Promise.allSettled(
      batch.map((c) =>
        harvestRepo(c.fullName, token, {
          stars: c.stars,
          defaultBranch: c.defaultBranch ?? licMeta.get(c.fullName)?.defaultBranch ?? null,
          license: licMeta.get(c.fullName)?.license ?? null,
        })
      )
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

  // Update the empty-mine memory — full transparency: the number is recorded in the stage evidence.
  // Race-safe: instead of writing the stale run-local copy (load-at-start → save-at-end,
  // which a concurrent recorder could clobber), the transaction re-reads the current
  // row and applies only THIS run's diffs (strikes to add, productive repos to unblock).
  const strikesToAdd = reports
    .filter((rep) => !rep.error && rep.artifacts === 0)
    .map((rep) => rep.repo);
  const toUnblock = reports.filter((rep) => rep.artifacts > 0).map((rep) => rep.repo);
  try {
    const { db: txdb } = await import("./db");
    await txdb.$transaction(
      async (tx) => {
        const row = await tx.setting.findUnique({ where: { key: MINE_ATTEMPTS_KEY } });
        let parsed: Record<string, number> = {};
        try {
          const v = row?.value ? JSON.parse(row.value) : null;
          if (v && typeof v === "object" && !Array.isArray(v)) parsed = v;
        } catch {
          // corrupted row — start fresh rather than losing the memory forever
        }
        for (const repo of strikesToAdd) parsed[repo] = (parsed[repo] ?? 0) + 1;
        for (const repo of toUnblock) delete parsed[repo];
        await tx.setting.upsert({
          where: { key: MINE_ATTEMPTS_KEY },
          update: { value: JSON.stringify(parsed) },
          create: { key: MINE_ATTEMPTS_KEY, value: JSON.stringify(parsed) },
        });
      },
      { timeout: 10_000 }
    );
  } catch {
    // The memory is an optimization — a save failure doesn't take down the stage
  }

  // Adaptive learning (WO4) — attribute added genes to the queries that surfaced
  // the mined repos; future hunts rank proven queries above never-productive ones.
  // executedQueries seeds zero-yield runs so sterile queries get demoted (see
  // recordQueryYields) — callers pass only queries that ran WITHOUT error.
  const queryAttribution: Record<string, number> = {};
  for (const rep of reports) {
    if (rep.newCount > 0) {
      const c = fresh.find((x) => x.fullName === rep.repo);
      for (const q of c?.viaQueries ?? []) queryAttribution[q] = (queryAttribution[q] ?? 0) + rep.newCount;
    }
  }
  await recordQueryYields(queryAttribution, executedQueries);

  return { reports, emptySkipped, queryAttribution };
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
  /** The queries that surfaced this repo (top 4) — adaptive-learning transparency */
  viaQueries: string[];
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
      viaQueries: c.viaQueries.slice(0, 4),
    };
  });
}
