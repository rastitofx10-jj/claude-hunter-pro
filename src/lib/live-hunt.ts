// ============================================================
// Live hunt — a full autonomous kill chain in a single click.
// The idea: all the engines we've built run on one closed chain, with live data:
//
//  hunt    — a live volley of GitHub queries (server token) → candidates with real premium models
//  swarm   — smart triage + investment profiles (LLM)
//  attack  — market patterns + attack plan + query evolution + briefing (LLM)
//  mine    — live DNA mining from the leading targets (GitHub → DNA library)
//  compile — automatic goal derivation from the intel → mission compilation from the new genes
//  execute — autopilot: one phase per call, until all phases complete
//  grow    — field distillation → new DNA born into the library (field:livehunt-<id>)
//  verdict — campaign verdict: full numbers, proof of library growth
//
// Principle from the autopilot: one phase per HTTP call. State is persisted to the DB after
// each phase — a restart doesn't kill the chain, and it can be retried from the current phase.
// Server-side only.
// ============================================================

import { db } from "@/lib/db";
import { safeJsonParse } from "./ai-json";
import { tierOf } from "./github";
import { TOKEN_KEY } from "./server-token";
import {
  buildAdaptiveArsenal,
  runQueryArsenal,
  consolidateCandidates,
  enrichCandidates,
  mineTopCandidates,
  flattenForSwarm,
  type Candidate,
  type CandidateFlat,
  type QueryReport,
  type SweepQuery,
} from "./deep-sweep";
import { scanAndRecord } from "./emerging-models";
import { loadYieldStats, rankByYield } from "./adaptive-learning";
import {
  triageBatch,
  sharpProfiles,
  patternSynthesis,
  attackPlan,
  queryEvolution,
  execBrief,
  type TriageVerdict,
  type SharpProfile,
  type MarketPatterns,
  type AttackPlan,
  type QueryEvolution,
  type ExecBrief,
} from "./intel-swarm";
import {
  selectDnaForGoal,
  compileMission,
  distillFieldReport,
  extractHandoff,
  type MissionPhase,
} from "./mission-compiler";
import { llmCallSnapshot } from "./zai";
import { writeDnaSnapshot } from "./dna-snapshot";
import { runNextAutopilotPhase, parseAutopilotState, AutopilotError } from "./autopilot";
import { advanceStatus, OUTCOME_STATUS } from "./mission-status";

export const LIVE_HUNT_STAGE_ORDER = [
  "hunt",
  "swarm",
  "attack",
  "mine",
  "compile",
  "execute",
  "grow",
  "verdict",
] as const;

export const LIVE_HUNT_STAGE_TITLES: Record<string, string> = {
  hunt: "Live detection — GitHub query volley",
  swarm: "Prompt swarm I — triage & profiles",
  attack: "Prompt swarm II — patterns & attack plan",
  mine: "Live DNA mining from the leading targets",
  compile: "Mission compilation from the intel and genes",
  execute: "Autonomous execution — per-phase autopilot",
  grow: "Field distillation — the library grows",
  verdict: "Campaign verdict — full evidence",
};

export interface LiveHuntStageRecord {
  key: string;
  title: string;
  summary: string;
  ms: number;
  evidence: Record<string, unknown>;
}

export class LiveHuntError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "LiveHuntError";
    this.status = status;
  }
}

interface HuntCtx {
  id: number;
  done: LiveHuntStageRecord[];
  evidence: (key: string) => Record<string, unknown> | null;
  /** Total LLM calls accumulated so far — for the campaign verdict (single source of truth) */
  llmCallsSoFar: number;
  /** Hunt generation — generation 2+ seeds the previous hunt's evolved queries */
  generation: number;
  /** Parent hunt — from which the evolved queries were seeded */
  seededFrom: number | null;
}

// ---------- Server token (DB ← env) ----------

async function getStoredToken(): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
    if (row?.value?.trim()) return row.value.trim();
  } catch {
    // fall back to env
  }
  return process.env.GITHUB_TOKEN ?? null;
}

// ---------- Helper structures ----------

interface SwarmStageState {
  flat: CandidateFlat[];
  elite: CandidateFlat[];
  watch: CandidateFlat[];
  triage: TriageVerdict[];
  profiles: SharpProfile[];
  autoSaved: number;
  autoSavedSkipped: number;
  llmCalls: number;
  llmFailures: string[];
}

interface AttackStageState {
  patterns: MarketPatterns;
  attack: AttackPlan;
  queryEvo: QueryEvolution;
  brief: ExecBrief;
  llmCalls: number;
  llmFailures: string[];
}

function readSwarmState(ctx: HuntCtx): SwarmStageState | null {
  const rec = ctx.evidence("swarm");
  if (!rec) return null;
  return rec as unknown as SwarmStageState;
}

function readAttackState(ctx: HuntCtx): AttackStageState | null {
  const rec = ctx.evidence("attack");
  if (!rec) return null;
  return rec as unknown as AttackStageState;
}

function readHuntEvidence(ctx: HuntCtx): Record<string, unknown> | null {
  return ctx.evidence("hunt");
}

function readMineEvidence(ctx: HuntCtx): Record<string, unknown> | null {
  return ctx.evidence("mine");
}

/** Forgiving LLM call — a failure doesn't take down the stage, it's recorded in failures */
async function llmTry<T>(fn: () => Promise<T>, failures: string[], label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${label}: ${e instanceof Error ? e.message : "error"}`);
    return null;
  }
}

// ---------- Stage 1: hunt ----------

/** Classify an evolved query to the correct endpoint: repo qualifiers (stars/fork/topic) are measured in repo search, the rest are code */
function evolvedKind(q: string): "code" | "repo" {
  if (/\b(stars|fork|pushed|topic|created|size):/i.test(q)) return "repo";
  return "code";
}

// Total cap on queries for a single hunt (static + evolved).
// Full arsenal = 26 core (15 registry-code + 4 capability-code + 7 repos) + 9 frontier
// (6 code + 3 repos) = 35 static. Generation 2+ adds ≤10 evolved.
// 40 = the maximum possible. Frontier slices rotate by generation (seed), so
// different generations probe different frontier coordinates.
// Timing budget: 28 code queries × 6.5s + 10 repo × 2.1 ≈ 203 seconds — headroom
// remains for quota-window holds against maxDuration=300.
const MAX_HUNT_QUERIES = 40;

/**
 * A deterministic threshold guard for evolved queries — we don't rely on the LLM to follow the rules.
 * Field evidence: Gen4+Gen5 repeatedly got repo:anthropic-ai/claude from the model — a repo that doesn't exist,
 * even though the prompt explicitly forbade it and included a dead list. All 10-12 queries returned 0 results.
 * The rule here, in code:
 * 1. A repo:owner/name qualifier is legal only if owner/name is in the list of real repos (elite/candidates/known anthropic).
 * 2. A query without a repo: qualifier passes (free code search can't be a non-existent repo).
 * 3. A dead pattern from the previous generation (0 results) is blocked even if the model changed only one word.
 */
function validateEvolvedQueries(
  rawQueries: string[],
  realRepos: Set<string>,
  deadQueries: string[],
  maxKeep = 10
): { kept: string[]; dropped: { q: string; why: string }[] } {
  const deadPatterns = deadQueries
    .map((d) => d.replace(/["']/g, "").split(/\s+/).filter((w) => w.length > 3))
    .filter((w) => w.length > 0);
  const kept: string[] = [];
  const dropped: { q: string; why: string }[] = [];
  for (const raw of rawQueries) {
    const q = String(raw ?? "").trim();
    if (q.length < 8 || q.length > 240) {
      dropped.push({ q, why: "invalid length" });
      continue;
    }
    const repoMatch = q.match(/\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (repoMatch && !realRepos.has(repoMatch[1].toLowerCase())) {
      dropped.push({ q, why: `repo:${repoMatch[1]} not in the list of real repos` });
      continue;
    }
    const bare = q.replace(/["']/g, "").toLowerCase();
    const isDeadPattern = deadPatterns.some(
      (dw) => dw.length >= 2 && dw.every((w) => bare.includes(w.toLowerCase()))
    );
    if (isDeadPattern) {
      dropped.push({ q, why: "duplicate of a pattern that returned 0 results in the previous generation" });
      continue;
    }
    // Quote-insensitive comparison on both sides — previously bare was compared against the original with quotes,
    // and any query containing " or ' bypassed the duplicate check and burned search quota twice.
    if (kept.some((k) => k.replace(/["']/g, "").toLowerCase() === bare)) {
      dropped.push({ q, why: "duplicate" });
      continue;
    }
    kept.push(q);
    if (kept.length >= maxKeep) break;
  }
  return { kept, dropped };
}

/**
 * Generational seeding: the queries the swarm proposed in the parent hunt actually execute in the child hunt — with a deterministic threshold guard.
 * (Before: queryEvolution was recorded and discarded; later: it was passed as-is — and the model invented non-existent repos every generation)
 */
/** Generational seeding. `known` — repos that previous generations saw; computed once in stageHunt
 * and passed inward (before: previousKnownRepos ran twice per hunt — 6 full rows + duplicate JSON parsing). */
async function parentEvolvedQueries(
  ctx: HuntCtx,
  known: Set<string>,
): Promise<{ queries: SweepQuery[]; blindSpots: string[]; parentId: number | null; dropped: { q: string; why: string }[] }> {
  if (!ctx.seededFrom) return { queries: [], blindSpots: [], parentId: null, dropped: [] };
  const parent = await db.liveHunt.findUnique({ where: { id: ctx.seededFrom } });
  if (!parent) return { queries: [], blindSpots: [], parentId: null, dropped: [] };
  const stages = safeJsonParse<LiveHuntStageRecord[]>(parent.stages ?? "[]", []);
  const attack = stages.find((s) => s.key === "attack")?.evidence as { queryEvo?: { nextQueries?: unknown; blindSpots?: unknown } } | undefined;
  const raw = Array.isArray(attack?.queryEvo?.nextQueries) ? (attack!.queryEvo!.nextQueries as unknown[]) : [];
  const blind = Array.isArray(attack?.queryEvo?.blindSpots) ? (attack!.queryEvo!.blindSpots as unknown[]) : [];

  // Real repos: everything ever seen + official Anthropic repos (existing and known)
  const realRepos = new Set([...known].map((r) => r.toLowerCase()));
  for (const r of ["anthropics/claude-code", "anthropics/skills", "anthropics/anthropic-sdk-python", "anthropics/anthropic-sdk-typescript", "anthropics/cookbooks"]) {
    realRepos.add(r.toLowerCase());
  }
  // Dead queries = what the parent ran and got 0 results from
  const parentHunt = stages.find((s) => s.key === "hunt")?.evidence as { queries?: { q?: unknown; count?: unknown }[] } | undefined;
  const deadQueries = (parentHunt?.queries ?? [])
    .filter((r) => typeof r?.q === "string" && r?.count === 0)
    .map((r) => r.q as string);

  const rawStrings = raw.map((x) => String(x ?? "").trim()).filter((q) => q.length >= 8);
  const { kept, dropped } = validateEvolvedQueries(rawStrings, realRepos, deadQueries, 10);
  const queries: SweepQuery[] = kept.map((q) => ({ q, kind: evolvedKind(q), origin: `evolved:gen${ctx.generation}` }));
  return { queries, blindSpots: blind.map((b) => String(b)).slice(0, 4), parentId: parent.id, dropped };
}

/** Union of all repos that previous generations already saw — for the generation's novelty check.
 * (Before: we read only flat[top12]+topCandidates[top10] — memory was truncated, and the "novel beyond prior knowledge" metric was fake: always ~935-22.
 * Now: we read all candidates ever seen (allNames) — a real measurement.) */
async function previousKnownRepos(): Promise<Set<string>> {
  const hunts = await db.liveHunt.findMany({ where: { status: "done" }, orderBy: { id: "desc" }, take: 6 });
  const known = new Set<string>();
  for (const h of hunts) {
    const stages = safeJsonParse<LiveHuntStageRecord[]>(h.stages ?? "[]", []);
    const he = stages.find((s) => s.key === "hunt")?.evidence as {
      allNames?: { fullName?: unknown }[];
      flat?: { fullName?: unknown }[];
      topCandidates?: { fullName?: unknown }[];
    } | undefined;
    for (const f of he?.allNames ?? []) if (typeof f?.fullName === "string") known.add(f.fullName);
    for (const f of he?.flat ?? []) if (typeof f?.fullName === "string") known.add(f.fullName);
    for (const t of he?.topCandidates ?? []) if (typeof t?.fullName === "string") known.add(t.fullName);
  }
  return known;
}

async function stageHunt(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const token = await getStoredToken();
  // Fail fast: without a token all 26 queries would fail 401 one-by-one with backoff —
  // minutes of noise before failure. Now: immediate failure with a precise message.
  if (!token) {
    throw new LiveHuntError("No GitHub token on the server — the live hunt requires a token (Settings → Token)", 400);
  }
  const arsenal = await buildAdaptiveArsenal(ctx.generation);

  // Accumulated knowledge — once per hunt (seeding and the novelty metric share it)
  const known = await previousKnownRepos();

  // Generational seeding — the parent's evolution queries actually hit the field
  const seed = await parentEvolvedQueries(ctx, known);
  const seenQ = new Set(arsenal.map((q) => q.q.toLowerCase()));
  const evolved = seed.queries.filter((q) => !seenQ.has(q.q.toLowerCase()));

  // Category-aware static allocation with floors — evolved queries replace registry
  // breadth, never the market/topic or frontier dimensions. (Before: a flat
  // "registry-first" sort starved all 7 repo searches in generation 2+; the same
  // sort would now starve the frontier — every category gets an explicit share.)
  // Adaptive learning (chimera WO4): within each category, yield-proven queries
  // rank first — so when evolved queries squeeze the budget, the survivors are
  // the queries that historically ADDED genes, not arbitrary pool order. Ties keep
  // rotation order, so novelty is preserved.
  const ystats = await loadYieldStats();
  const staticBudget = Math.max(0, MAX_HUNT_QUERIES - evolved.length);
  const repoQ = arsenal.filter((q) => q.kind === "repo"); // 10 — always all (2.1s spacing, cheap quota)
  let left = Math.max(0, staticBudget - repoQ.length);
  const frontierQ = rankByYield(arsenal.filter((q) => q.origin.startsWith("frontier")), ystats); // frontier + frontier-model + frontier-emerging —
  // the whole frontier dimension. (History: a strict === "frontier" match once silently dropped
  // every frontier-model query — a past strict-match bug once silently dropped them.)
  const capQ = rankByYield(arsenal.filter((q) => q.origin === "capability"), ystats); // 4
  const regQ = rankByYield(arsenal.filter((q) => q.origin.startsWith("registry")), ystats); // 15
  // capability floor (2) survives even when evolved queries squeeze the budget
  const capFloor = Math.min(2, capQ.length, left);
  const frontierTake = frontierQ.slice(0, Math.max(0, left - capFloor));
  left -= frontierTake.length;
  const capTake = capQ.slice(0, Math.min(capQ.length, left));
  left -= capTake.length;
  const regTake = regQ.slice(0, Math.min(regQ.length, left));
  const staticQ: SweepQuery[] = [...repoQ, ...frontierTake, ...capTake, ...regTake];
  const queries = [...staticQ, ...evolved];

  const { reports, codeHits, repoHits } = await runQueryArsenal(token, queries, () => {});

  // Frontier radar feed — the hunt's own catch (descriptions, topics, matched paths)
  // feeds the emerging-model ledger. A single-repo mention stays recorded but
  // unconfirmed; the next repo that mentions it turns the signal into a wave.
  try {
    for (const h of repoHits) {
      await scanAndRecord(`${h.fullName} ${h.description ?? ""} ${h.topics.join(" ")}`, h.fullName);
    }
    for (const h of codeHits) {
      await scanAndRecord(h.path, h.repo, h.path);
    }
  } catch { /* radar must never stall the hunt */ }

  const emergingQs = queries
    .filter((q) => q.origin.startsWith("frontier-emerging"))
    .map((q) => q.q);
  let candidates: Candidate[] = consolidateCandidates(codeHits, repoHits, emergingQs);
  const enriched = await enrichCandidates(candidates, token, 20);
  const flat = flattenForSwarm(candidates);

  // Chain stop: a hunt that found nothing doesn't go on to build a mission out of thin air.
  // Before: 0 candidates silently passed all 8 stages — a generic-goal mission and a false "success" report.
  if (candidates.length === 0) {
    const failedQ = reports.filter((r: QueryReport) => r.error).length;
    const errTail = reports
      .filter((r: QueryReport) => r.error)
      .slice(0, 3)
      .map((r: QueryReport) => r.error)
      .join(" · ");
    throw new LiveHuntError(
      failedQ > 0
        ? `The hunt found no candidates — ${failedQ}/${queries.length} queries failed${errTail ? ` (${errTail})` : ""}`
        : "The hunt found no candidates — nothing to build a chain from (try a new generation or widen the range)",
      502,
    );
  }

  // Novelty — what this generation discovers beyond all the accumulated knowledge of previous generations
  const novelCandidates = candidates.filter((c) => !known.has(c.fullName));
  const repeatPct = candidates.length ? Math.round(((candidates.length - novelCandidates.length) / candidates.length) * 100) : 0;

  const hard = candidates.filter((c) => c.evidence === "hard").length;
  const genTag =
    ctx.generation > 1
      ? ` · generation ${ctx.generation} (seeded from hunt #${seed.parentId}: ${evolved.length} queries${seed.dropped.length ? `, ${seed.dropped.length} rejected by the threshold guard` : ""})`
      : "";
  const novelTag = known.size > 0 ? ` · ${novelCandidates.length} novel / ${repeatPct}% already seen in previous generations` : "";
  const summary = `${queries.length} queries · ${candidates.length} ranked candidates · ${hard} with hard evidence · ${repoHits.length} repos${genTag}${novelTag}`;

  return {
    summary,
    evidence: {
      withToken: !!token,
      generation: ctx.generation,
      seededFrom: seed.parentId,
      evolvedQueries: evolved.map((q) => ({ q: q.q, kind: q.kind, origin: q.origin })),
      parentBlindSpots: seed.blindSpots,
      evolvedDropped: seed.dropped,
      novelCandidates: known.size > 0 ? novelCandidates.length : null,
      repeatPct: known.size > 0 ? repeatPct : null,
      allNames: candidates.map((c) => ({ fullName: c.fullName })),
      novelTop: novelCandidates.slice(0, 10).map((c) => ({
        fullName: c.fullName,
        stars: c.stars,
        score: c.score,
        evidence: c.evidence,
        modelStrings: c.modelStrings.slice(0, 4),
      })),
      knownBefore: known.size,
      queries: reports.map((r: QueryReport) => ({ q: r.q, kind: r.kind, count: r.count, error: r.error ?? null, origin: r.origin })),
      codeHits: codeHits.length,
      repoHits: repoHits.length,
      candidates: candidates.length,
      enriched,
      hardEvidence: hard,
      flat: flat.slice(0, 12),
      topCandidates: candidates.slice(0, 10),
      executedQueries: queries.map((q) => q.q),
      statsLine: `${queries.length} queries · ${codeHits.length} code hits · ${repoHits.length} repos · ${candidates.length} candidates · ${enriched} enriched`,
      topList: candidates.slice(0, 8).map((c) => ({
        fullName: c.fullName,
        stars: c.stars,
        score: c.score,
        evidence: c.evidence,
        // Before: c.tierLabel — a field that doesn't exist on Candidate (only on CandidateFlat),
        // entered as undefined and dropped from the JSON. Now computed from the score like in flattenForSwarm.
        tierLabel: tierOf(Math.min(100, c.score)).label,
        modelStrings: c.modelStrings.slice(0, 5),
      })),
    },
  };
}

// ---------- Stage 2: swarm (triage + profiles) ----------

async function stageSwarm(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const flat = (huntEv?.flat as CandidateFlat[] | undefined) ?? [];
  if (flat.length === 0) {
    return {
      summary: "No candidates from the previous stage — the swarm skips",
      // Conform to the full SwarmStageState shape — before, autoSaved/autoSavedSkipped were missing
      // and readSwarmState read them as undefined in the skip case (it only worked by luck, thanks to ??)
      evidence: { flat: [], triage: [], profiles: [], elite: [], watch: [], autoSaved: 0, autoSavedSkipped: 0, llmCalls: 0, llmFailures: [] },
    };
  }

  const failures: string[] = [];
  let calls = 0;

  // Triage — a single batch of 12 (HTTP time limit preserved)
  const batch = flat.slice(0, 12);
  // Count per call, not per content: a model that returned a valid [] — the call happened and it cost.
  // (Before: a valid-empty answer wasn't counted and the counter in the verdict under-reported)
  const triage = (await llmTry(() => triageBatch(batch), failures, "triage")) ?? [];
  calls++; // llmTry returns null only on failure; ?? [] represents success even when empty

  const eliteNames = new Set(triage.filter((t) => t.verdict === "elite").map((t) => t.fullName));
  const watchNames = new Set(triage.filter((t) => t.verdict === "watch").map((t) => t.fullName));
  const elite = batch.filter((c) => eliteNames.has(c.fullName)).slice(0, 12);
  const watch = batch.filter((c) => watchNames.has(c.fullName)).slice(0, 12);

  // Profiles for the elite only, batches of 6
  const profiles: SharpProfile[] = [];
  for (const pb of chunk(elite, 6)) {
    const res = await llmTry(() => sharpProfiles(pb), failures, "profiles");
    if (res) {
      profiles.push(...res);
      calls++;
    }
  }

  // Auto-archiving: live elite enters the saved list with an explicit marker — intel preserved across generations
  // One up-front query instead of findUnique per elite — before, up to 12×2 sequential DB rounds (N+1)
  let autoSaved = 0;
  let autoSavedSkipped = 0;
  const triageMap = new Map(triage.map((t) => [t.fullName, t]));
  const eliteFullNames = elite.map((e) => e.fullName);
  const existingRows = eliteFullNames.length
    ? await db.savedRepo.findMany({ where: { fullName: { in: eliteFullNames } }, select: { fullName: true, notes: true, stars: true, score: true } })
    : [];
  const existingMap = new Map(existingRows.map((r) => [r.fullName, r]));
  for (const e of elite) {
    try {
      const existing = existingMap.get(e.fullName) ?? null;
      const reason = triageMap.get(e.fullName)?.reason?.slice(0, 140) ?? "elite in triage";
      if (!existing) {
        await db.savedRepo.create({
          data: {
            fullName: e.fullName,
            owner: e.fullName.split("/")[0] ?? "",
            name: e.fullName.split("/").slice(1).join("/"),
            url: `https://github.com/${e.fullName}`,
            description: e.description,
            stars: e.stars ?? 0,
            score: Math.min(100, Math.round(e.score ?? 0)),
            models: e.modelStrings?.slice(0, 6).join(",") ?? null,
            evidence: JSON.stringify({ contentEvidence: (e.contentEvidence ?? []).slice(0, 3), tier: e.tierLabel ?? null }),
            notes: `⚔️ Automatic live hunt (#${ctx.id} generation ${ctx.generation}): ${reason}`,
          },
        });
        autoSaved++;
      } else {
        // Saved manually by the user — we don't touch their notes; an existing hunt marker only gets updated
        if (existing.notes?.includes("Automatic live hunt")) {
          await db.savedRepo.update({
            where: { fullName: e.fullName },
            data: { stars: e.stars ?? existing.stars, score: Math.max(existing.score, Math.min(100, Math.round(e.score ?? 0))) },
          });
          autoSaved++;
        } else {
          autoSavedSkipped++;
        }
      }
    } catch (saveErr) {
      failures.push(`elite archive ${e.fullName}: ${saveErr instanceof Error ? saveErr.message : "error"}`);
    }
  }

  const summary = `${triage.length} triaged · ${elite.length} elite · ${watch.length} watch · ${profiles.length} profiles · ${autoSaved} auto-saved${
    failures.length ? ` · ${failures.length} failures` : ""
  }`;

  const state: SwarmStageState = { flat, elite, watch, triage, profiles, autoSaved, autoSavedSkipped, llmCalls: calls, llmFailures: failures };
  return { summary, evidence: state as unknown as Record<string, unknown> };
}

// ---------- Stage 3: attack (patterns + attack + queries + briefing) ----------

async function stageAttack(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const swarm = readSwarmState(ctx);
  if (!swarm) throw new LiveHuntError("Swarm state missing — the swarm stage is required", 500);

  const failures: string[] = [];
  let calls = 0;
  const safePatterns: MarketPatterns = { patterns: [], stackConsensus: [], marketShift: "" };

  const patterns =
    (await llmTry(() => patternSynthesis(swarm.elite, swarm.watch), failures, "patterns")) ?? safePatterns;
  if (patterns !== safePatterns) calls++;

  const attack =
    (await llmTry(() => attackPlan(swarm.elite, swarm.profiles, patterns), failures, "attack plan")) ?? {
      topMoves: [],
      differentiators: [],
      immediateActions: [],
    };
  if (attack) calls++; // A successful call counts even if the model returned a valid-empty plan

  const queryEvo =
    (await llmTry(
      () =>
        queryEvolution(
          ((readHuntEvidence(ctx)?.queries as { q?: unknown; count?: unknown; error?: unknown }[] | undefined) ?? []).map((r) => ({
            q: typeof r?.q === "string" ? r.q : "",
            count: typeof r?.count === "number" ? r.count : -1,
            error: typeof r?.error === "string" ? r.error : null,
          })),
          swarm.elite
        ),
      failures,
      "query evolution"
    )) ?? { nextQueries: [], blindSpots: [], rationale: "" };
  if (queryEvo) calls++;

  const brief =
    (await llmTry(
      () =>
        execBrief({
          statsLine: (readHuntEvidence(ctx)?.statsLine as string | undefined) ?? "",
          eliteCount: swarm.elite.length,
          patterns,
          attack,
          dnaAdded: 0,
        }),
      failures,
      "briefing"
    )) ?? { headline: "No briefing received", keyIntel: [], decisiveMove: "", riskMap: failures.slice(0, 3) };
  if (brief) calls++;

  const summary = `${patterns.patterns.length} patterns · ${attack.topMoves.length} moves · ${queryEvo.nextQueries.length} next queries${
    failures.length ? ` · ${failures.length} LLM failures` : ""
  }`;

  const state: AttackStageState = { patterns, attack, queryEvo, brief, llmCalls: calls, llmFailures: failures };
  return { summary, evidence: state as unknown as Record<string, unknown> };
}

// ---------- Stage 4: mine (live DNA mining) ----------

async function stageMine(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const token = await getStoredToken();
  const top = (huntEv?.topCandidates as Candidate[] | undefined) ?? [];
  if (top.length === 0) {
    return {
      summary: "No targets to mine — skipping (the library doesn't grow at this stage)",
      evidence: { mined: [], reposMined: 0, dnaAdded: 0 },
    };
  }

  // Adaptive learning: the hunt's executed queries (stage-1 evidence) feed the yield
  // ledger — error-free runs count even at 0 genes so sterile queries get demoted.
  const huntQueries = (huntEv?.queries as { q: string; error?: string | null }[] | undefined) ?? [];
  const cleanHuntQueries = huntQueries.filter((q) => !q.error).map((q) => q.q);
  const { reports: mined, emptySkipped } = await mineTopCandidates(top, token, 3, undefined, cleanHuntQueries);
  // Measurement honesty: "mined" = a repo that yielded artifacts. A repo that was swept and returned 0 doesn't count as mined —
  // before: "3 repos mined" hid that none of them yielded anything.
  const reposAttempted = mined.length;
  const reposMined = mined.filter((m) => !m.error).length;
  const reposWithFindings = mined.filter((m) => !m.error && (m.artifacts ?? 0) > 0).length;
  const mineErrors = mined.filter((m) => m.error);
  const dnaAdded = mined.reduce((acc, m) => acc + (m.newCount ?? 0), 0);
  const stubsSkipped = mined.reduce((acc, m) => acc + (m.skippedStubs ?? 0), 0);

  const summary = `${reposWithFindings}/${reposMined} repos yielded genes (out of ${reposAttempted} targets) · ${dnaAdded} new genes in the library${stubsSkipped ? ` · ${stubsSkipped} stub genes rejected` : ""}${
    emptySkipped ? ` · ${emptySkipped} proven-empty skipped` : ""
  }${mineErrors.length ? ` · ${mineErrors.length} mining failures` : ""}`;

  return {
    summary,
    evidence: {
      mined: mined.map((m) => ({ repo: m.repo, artifacts: m.artifacts, newCount: m.newCount, updatedCount: m.updatedCount, skippedStubs: m.skippedStubs ?? 0, kinds: m.kinds, error: m.error ?? null })),
      reposAttempted,
      reposMined,
      reposWithFindings,
      mineErrorCount: mineErrors.length,
      dnaAdded,
      stubsSkipped,
      // Transparency: repos already proven empty (2 mines with no results) are not mined again
      emptySkipped,
    },
  };
}

// ---------- Stage 5: compile (goal derivation + compilation) ----------

function deriveGoal(swarm: SwarmStageState | null, attack: AttackStageState | null, huntEv: Record<string, unknown> | null): string {
  const a = attack?.attack.immediateActions?.[0] ?? "";
  const m = attack?.attack.topMoves?.[0]?.move ?? "";
  const briefMove = attack?.brief.decisiveMove ?? "";
  const signature = swarm?.profiles?.[0]?.signature ?? "";
  const topName = (huntEv?.topList as { fullName?: string }[] | undefined)?.[0]?.fullName ?? "the leading target";

  const raw = a || m || briefMove || signature;
  const core = raw.trim().slice(0, 220);
  if (core) {
    return `${core} — based on the live intel from the hunt (leader: ${topName})`;
  }
  return `Analyze and extract an advantage from the real premium-model investment (Opus 4.5 class) exposed in the live hunt (leader: ${topName})`;
}

async function stageCompile(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const swarm = readSwarmState(ctx);
  const attack = readAttackState(ctx);
  const huntEv = readHuntEvidence(ctx);

  // Compilation idempotency: if a previous compile attempt created a mission and only failed at updating the hunt
  // row (before: two separate writes) — a retry doesn't produce a second orphan mission.
  // The missionId link is written to the hunt row in the same transaction as mission creation (below),
  // so its existence here = the mission was already created successfully.
  const linked = await db.liveHunt.findUnique({ where: { id: ctx.id }, select: { missionId: true } });
  if (linked?.missionId) {
    const existing = await db.mission.findUnique({ where: { id: linked.missionId } });
    if (existing) {
      const existingPlan = safeJsonParse<{ phases?: MissionPhase[]; skillMdSource?: string; oneLiner?: string }>(existing.plan, {});
      const existingDnaRefs = safeJsonParse<Array<{ id?: number; path?: string; name?: string; kind?: string; sourceRepo?: string }>>(existing.dnaRefs, []);
      const existingRisks = safeJsonParse<string[]>(existing.risks, []);
      return {
        summary: `Mission #${existing.id} "${existing.missionName}" — restored from the previous attempt (without recompiling)`,
        evidence: {
          missionId: existing.id,
          missionName: existing.missionName,
          oneLiner: existingPlan.oneLiner ?? "",
          phases: (existingPlan.phases ?? []).map((p: MissionPhase) => p.title),
          dnaRefs: existingDnaRefs,
          skillMdSource: existingPlan.skillMdSource ?? "unknown",
          skillMdLines: (existing.skillMd ?? "").split("\n").length,
          risks: existingRisks.slice(0, 4),
          goal: existing.goal,
          reusedAfterFailure: true,
          librarySize: await db.dnaArtifact.count(),
        },
      };
    }
  }

  const goal = deriveGoal(swarm, attack, huntEv);
  const contextBits: string[] = [];
  if (attack?.patterns.marketShift) contextBits.push(`Market shift: ${attack.patterns.marketShift.slice(0, 200)}`);
  if (swarm?.elite.length) contextBits.push(`Elite: ${swarm.elite.map((e) => e.fullName).join(", ").slice(0, 300)}`);
  if (attack?.brief.headline) contextBits.push(`Campaign headline: ${attack.brief.headline.slice(0, 150)}`);
  const context = contextBits.join("\n").slice(0, 1200);

  // One DNA-selection path for the whole system — the same selectDnaForGoal that /api/mission uses
  // (metadata-only pre-rank over the newest 500 → content only for the leaders, truncated to 4,000
  // chars at the source). (Before: this stage ran its own single-pass raw-SQL ranking over the entire
  // library — a second, divergent selection path; the two could pick different genes for one goal.)
  const selected = await selectDnaForGoal(goal, 8);
  const compiled = await compileMission(goal, context, selected);

  if (!compiled.phases || compiled.phases.length === 0) {
    throw new LiveHuntError("The compiled plan is empty — there are no phases to execute", 502);
  }

  // Mission creation + linking it to the hunt row in a single transaction —
  // before: two separate writes; a crash in between left an orphan mission and the retry duplicated it.
  const mission = await db.$transaction(async (tx) => {
    const m = await tx.mission.create({
      data: {
        goal,
        context: context || null,
        missionName: compiled.missionName,
        status: "compiled",
        plan: JSON.stringify({ oneLiner: compiled.oneLiner, phases: compiled.phases, skillMdSource: compiled.skillMdSource }),
        dnaRefs: JSON.stringify(
          compiled.selectedDna.map((d) => ({ id: d.id, path: d.path, name: d.name, kind: d.kind, sourceRepo: d.sourceRepo }))
        ),
        promptSequence: JSON.stringify(compiled.promptSequence),
        skillMd: compiled.skillMd,
        risks: JSON.stringify(compiled.risks),
        successCriteria: JSON.stringify(compiled.successCriteria),
      },
    });
    await tx.liveHunt.update({ where: { id: ctx.id }, data: { missionId: m.id } });
    return m;
  });

  const summary = `Mission #${mission.id} "${compiled.missionName}" · ${compiled.phases.length} phases · ${selected.length} genes selected · SKILL.md (${compiled.skillMdSource})`;

  return {
    summary,
    evidence: {
      missionId: mission.id,
      missionName: compiled.missionName,
      oneLiner: compiled.oneLiner,
      phases: compiled.phases.map((p: MissionPhase) => p.title),
      dnaRefs: compiled.selectedDna.map((d) => ({ name: d.name, kind: d.kind, sourceRepo: d.sourceRepo, reason: d.reason })),
      skillMdSource: compiled.skillMdSource,
      skillMdLines: compiled.skillMd.split("\n").length,
      risks: compiled.risks.slice(0, 4),
      goal,
      // The true library size (previously rows.length from the local full-table SQL — count()
      // returns exactly the same number, and now matches the restored-mission branch above)
      librarySize: await db.dnaArtifact.count(),
    },
  };
}

// ---------- Stage 6: execute (autopilot — one phase per call, repeats until done) ----------

async function stageExecute(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown>; stay: boolean }> {
  const compileEv = ctx.evidence("compile");
  const missionId = Number(compileEv?.missionId);
  if (!Number.isInteger(missionId) || missionId <= 0) {
    throw new LiveHuntError("Mission ID missing — the compile stage is required", 500);
  }

  const result = await runNextAutopilotPhase(missionId);

  const last = result.state.steps[result.state.steps.length - 1] ?? null;
  const fail = result.failure;
  const preview = last?.deliverable
    ? `${extractHandoff(last.deliverable).slice(0, 240)}`
    : fail
      ? `Phase failed: ${fail.error.slice(0, 200)}`
      : "Not executed";

  const summary = result.allDone
    ? `Execution complete: ${result.stepsDone}/${result.totalPhases} phases${result.state.failures.length ? ` (${result.state.failures.length} failures)` : ""}`
    : `Phase ${result.stepsDone}/${result.totalPhases} executed — continuing`;

  return {
    summary,
    evidence: {
      missionId,
      stepsDone: result.stepsDone,
      totalPhases: result.totalPhases,
      allDone: result.allDone,
      failuresCount: result.state.failures.length,
      lastPhaseIndex: last?.phaseIndex ?? fail?.phaseIndex ?? null,
      lastPhaseTitle: last?.title ?? null,
      deliverablePreview: preview,
      deliverableLength: last?.deliverable?.length ?? 0,
    },
    stay: !result.allDone,
  };
}

// ---------- Stage 7: grow (field distillation → DNA birth) ----------

function localDistill(input: { outcome: string; notes: string }) {
  const outcomeHeb =
    input.outcome === "success" ? "full success" : input.outcome === "partial" ? "partial success" : "failure";
  const lessons: string[] = [];
  for (const s of input.notes.split(/[\n.!?]+|\.\s/)) {
    const t = s.trim();
    if (t.length >= 12) lessons.push(t);
    if (lessons.length >= 5) break;
  }
  if (lessons.length === 0) {
    lessons.push(
      input.outcome === "failed"
        ? "Failure is a data point: document where things got stuck and split the phase into smaller steps"
        : "Document which phases passed verification easily — candidates for DNA in future missions"
    );
  }
  return {
    verdict: `Field report (${outcomeHeb}) saved — AI distillation unavailable, lessons extracted locally`,
    lessons,
    newDna: null,
  };
}

async function stageGrow(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const compileEv = ctx.evidence("compile");
  const missionId = Number(compileEv?.missionId);
  if (!Number.isInteger(missionId) || missionId <= 0) {
    throw new LiveHuntError("Mission ID missing for the field distillation", 500);
  }
  const mission = await db.mission.findUnique({ where: { id: missionId } });
  if (!mission) throw new LiveHuntError(`Mission #${missionId} has disappeared`, 404);

  const state = parseAutopilotState(mission.autopilot);
  let phaseTitles: string[] = [];
  try {
    const planRaw: unknown = JSON.parse(mission.plan);
    const plan = planRaw && typeof planRaw === "object" ? (planRaw as { phases?: unknown }) : {};
    phaseTitles = Array.isArray(plan.phases)
      ? plan.phases
          .filter((p): p is { title?: unknown } => typeof p === "object" && p !== null)
          .map((p) => (typeof p.title === "string" ? p.title : ""))
          .filter(Boolean)
      : [];
  } catch {
    phaseTitles = [];
  }

  // Outcome rule: 0 executed phases = failure, even if no explicit failure was recorded —
  // before: a lost state (empty autopilot) was distilled as "full success".
  const outcome =
    state.steps.length === 0 ? "failed" : state.failures.length === 0 ? "success" : "partial";
  const lastDeliverable = state.steps[state.steps.length - 1]?.deliverable ?? "";
  const notes =
    `${extractHandoff(lastDeliverable)}\n${state.failures.map((f) => `Phase ${f.phaseIndex + 1} failed: ${f.error}`).join("\n")}`
      .trim()
      .slice(0, 3500);

  let distilled: Awaited<ReturnType<typeof distillFieldReport>>;
  let distillMethod: "ai" | "local" = "ai";
  try {
    distilled = await distillFieldReport({ goal: mission.goal, phaseTitles, outcome, notes });
  } catch {
    distilled = localDistill({ outcome, notes });
    distillMethod = "local";
  }

  // DNA birth from the field — consistent with the manual reporting path (a fixed path prevents divergence)
  let bornDnaId: number | null = null;
  let dnaBirthError: string | null = null;
  if (distilled.newDna) {
    const content = distilled.newDna.content;
    try {
      const created = await db.dnaArtifact.upsert({
        where: {
          sourceRepo_path: {
            sourceRepo: `field:livehunt-${ctx.id}`,
            path: "field/lesson/SKILL.md",
          },
        },
        update: { description: distilled.newDna.description, content, size: content.length },
        create: {
          sourceRepo: `field:livehunt-${ctx.id}`,
          path: "field/lesson/SKILL.md",
          kind: "skill",
          name: distilled.newDna.name || "live-hunt-lesson",
          description: distilled.newDna.description,
          content,
          size: content.length,
          // A field lesson born from our own runs — our IP, no distribution limits
          license: "self",
        },
      });
      bornDnaId = created.id;
    } catch (dnaErr) {
      // Before: a birth failure was console-only — the evidence couldn't distinguish "the AI decided there's no DNA"
      // from "the DB write failed". Now it's visible in the evidence and the UI.
      dnaBirthError = dnaErr instanceof Error ? dnaErr.message : "error";
      console.error("[live-hunt] DNA birth failed (report still saved):", dnaErr);
    }
  }

  // Mission status update — forward-only (one rule from the mission-status module), report history is preserved
  // Report idempotency: a grow retry doesn't duplicate records — the previous record from the same source
  // is replaced. Before: a retry after a mission-update failure added a duplicate report.
  // round 8: the read at the top of stageGrow is up to ~110s stale (distillation + DNA
  // birth). A manual field report landing in that window was silently ERASED by this
  // last-writer-wins update — the exact lost-update race the manual report route already
  // fixed with transaction + re-read + CAS. Port of that fix: fresh re-read, history
  // rebuilt from the FRESH value, compare-and-swap on (status, report), 3 attempts.
  const newReport = {
    outcome,
    notes: notes || null,
    verdict: distilled.verdict,
    lessons: distilled.lessons,
    bornDnaId,
    distillMethod,
    source: `livehunt-${ctx.id}`,
    reportedAt: new Date().toISOString(),
  };
  let growErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = await db.mission.findUnique({ where: { id: missionId }, select: { status: true, report: true } });
      if (!fresh) throw new LiveHuntError(`Mission #${missionId} has disappeared`, 404);
      let freshHistory: Array<Record<string, unknown>> = [];
      try {
        const prev: unknown = fresh.report ? JSON.parse(fresh.report) : null;
        if (Array.isArray(prev)) freshHistory = prev.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
        else if (prev && typeof prev === "object") freshHistory = [prev as Record<string, unknown>];
      } catch {
        freshHistory = [];
      }
      freshHistory = freshHistory.filter((r) => r.source !== `livehunt-${ctx.id}`);
      const freshFinalStatus = advanceStatus(fresh.status, OUTCOME_STATUS[outcome] ?? fresh.status);
      const finalReportJson = JSON.stringify([...freshHistory, newReport].slice(-20));
      // CAS with Prisma-null semantics (report IS NULL matches a never-reported mission)
      const cas = await db.mission.updateMany({
        where: { id: missionId, status: fresh.status, report: fresh.report },
        data: { status: freshFinalStatus, report: finalReportJson },
      });
      if (cas.count === 0) {
        const retry = new Error("GROW_REPORT_CHANGED_RETRY");
        retry.name = "GrowReportChangedRetry";
        throw retry;
      }
      growErr = null;
      break;
    } catch (e) {
      if (e instanceof Error && e.name === "GrowReportChangedRetry" && attempt < 2) continue;
      growErr = e;
      break;
    }
  }
  if (growErr) throw growErr;

  const summary = `${distillMethod === "ai" ? "AI-distilled" : "local distillation"} · ${distilled.lessons.length} lessons${
    bornDnaId ? ` · DNA #${bornDnaId} born into the library 🧬` : dnaBirthError ? ` · DNA birth failed (${dnaBirthError.slice(0, 80)})` : " · no new DNA"
  }`;

  return {
    summary,
    evidence: {
      missionId,
      outcome,
      distillMethod,
      // Stage display only (the UI shows this stage's usage): AI distillation = 1 call, local = 0.
      // The hunt total is no longer derived from here — runNextLocked accumulates exact
      // per-attempt deltas from the zai.ts counter, so retries are counted too.
      llmCalls: distillMethod === "ai" ? 1 : 0,
      verdict: distilled.verdict,
      lessons: distilled.lessons,
      bornDnaId,
      dnaBirthError,
      bornSource: bornDnaId ? `field:livehunt-${ctx.id}` : null,
      phaseTitles,
      autopilotSteps: state.steps.length,
      autopilotFailures: state.failures.length,
    },
  };
}

// ---------- Stage 8: verdict ----------

async function stageVerdict(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const compileEv = ctx.evidence("compile");
  const growEv = ctx.evidence("grow");
  const mineEv = readMineEvidence(ctx);
  const swarm = readSwarmState(ctx);
  const attack = readAttackState(ctx);

  const [dnaAfter, missionCount] = await Promise.all([
    db.dnaArtifact.count(),
    db.mission.count(),
  ]);

  const bornDnaId = Number(growEv?.bornDnaId) || null;
  // novelTop exists in the evidence (written in stageHunt) but the local type didn't declare it —
  // the typing lied about the data shape; now declared explicitly.
  const huntEv2 = huntEv as { novelCandidates?: unknown; novelTop?: unknown[]; evolvedQueries?: unknown[]; knownBefore?: unknown } | null;
  const summary = `Generation ${ctx.generation} · ${ctx.done.length} stages · ${missionCount} missions total · ${ctx.llmCallsSoFar} LLM calls`;

  return {
    summary,
    evidence: {
      missionId: Number(compileEv?.missionId) || null,
      missionName: compileEv?.missionName ?? null,
      missionGoal: compileEv?.goal ?? null,
      huntStats: {
        queries: Array.isArray(huntEv?.queries) ? (huntEv?.queries as unknown[]).length : 0,
        candidates: Number(huntEv?.candidates) || 0,
        hardEvidence: Number(huntEv?.hardEvidence) || 0,
        generation: ctx.generation,
        seededFrom: ctx.seededFrom,
        evolvedQueriesRun: Array.isArray(huntEv2?.evolvedQueries) ? huntEv2!.evolvedQueries!.length : 0,
        novelCandidates: typeof huntEv2?.novelCandidates === "number" ? huntEv2.novelCandidates : null,
        novelTop: Array.isArray(huntEv2?.novelTop) ? (huntEv2!.novelTop as Array<Record<string, unknown>>).slice(0, 6) : [],
        knownBefore: Number(huntEv2?.knownBefore) || 0,
      },
      swarm: { elite: swarm?.elite.length ?? 0, watch: swarm?.watch.length ?? 0, llmCalls: swarm?.llmCalls ?? 0, autoSaved: swarm?.autoSaved ?? 0 },
      attack: { topMoves: attack?.attack.topMoves.length ?? 0, nextQueries: attack?.queryEvo.nextQueries.length ?? 0, llmCalls: attack?.llmCalls ?? 0 },
      briefHeadline: attack?.brief.headline ?? null,
      decisiveMove: attack?.brief.decisiveMove ?? null,
      mine: { reposMined: Number(mineEv?.reposMined) || 0, dnaAdded: Number(mineEv?.dnaAdded) || 0 },
      growth: {
        bornDnaId,
        bornSource: growEv?.bornSource ?? null,
        lessons: growEv?.lessons ?? [],
        distillMethod: growEv?.distillMethod ?? null,
      },
      totals: {
        dnaAfter,
        missionCount,
        // Single source of truth: the accumulated counter on the hunt row (before: a local formula that contradicted the counter)
        // Measurement method: exact per-attempt deltas from the global LLM queue (zai.ts llmCallSnapshot) —
        // every real SDK attempt is counted, 429 retries included, which is the honest number for quota pressure
        llmCalls: ctx.llmCallsSoFar,
        llmCallsBasis: "exact: per-attempt deltas from the global LLM queue (zai.ts); 429 retries counted",
      },
    },
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- State machine ----------

/**
 * Hunt start: a start lock closes the race window between the check ("no active run")
 * and creation — without it, two parallel "Start" clicks created two hunts, both running.
 * (Exactly the startSweep/startingSweep pattern — applied here to the live hunt as well.)
 */
let startingHunt = false;

export async function startLiveHunt(): Promise<{ id: number }> {
  if (startingHunt) {
    throw new LiveHuntError("A hunt start is already in progress — one moment", 409);
  }
  startingHunt = true;
  try {
    // Only one active run — a run not updated for 15 minutes is considered dead
    const staleCutoff = new Date(Date.now() - 15 * 60_000);
    await db.liveHunt.updateMany({
      where: { status: "running", updatedAt: { lt: staleCutoff } },
      data: { status: "failed", error: "The run was interrupted (the server was restarted) — marked automatically" },
    });
    // deterministic newest-first (round 8: no orderBy made the 409 winner arbitrary
    // if two rows were ever running simultaneously)
    const active = await db.liveHunt.findFirst({ where: { status: "running" }, select: { id: true }, orderBy: { id: "desc" } });
    if (active) {
      throw new LiveHuntError("A live hunt is already running — wait for it to finish", 409);
    }
    const dnaBefore = await db.dnaArtifact.count();
    // Generational lineage: every new hunt is generation+1 from the last successful hunt — the child hunts with the parent's evolved queries
    const prevDone = await db.liveHunt.findFirst({ where: { status: "done" }, orderBy: { id: "desc" }, select: { id: true, generation: true } });
    const generation = (prevDone?.generation ?? 0) + 1;
    const seededFrom = prevDone?.id ?? null;
    const hunt = await db.liveHunt.create({
      data: { status: "running", stageKey: "hunt", dnaBefore, generation, seededFrom },
    });
    return { id: hunt.id };
  } finally {
    startingHunt = false;
  }
}

export interface LiveHuntState {
  id: number;
  status: string;
  stageKey: string;
  done: boolean;
  goal: string;
  missionId: number | null;
  generation: number;
  seededFrom: number | null;
  dnaBefore: number;
  dnaAfter: number;
  llmCalls: number;
  elapsedMs: number;
  error: string | null;
  stages: LiveHuntStageRecord[];
  stageOrder: readonly string[];
}

export function serializeLiveHunt(row: {
  id: number;
  status: string;
  stageKey: string;
  stages: string | null;
  goal: string;
  missionId: number | null;
  generation: number;
  seededFrom: number | null;
  dnaBefore: number;
  dnaAfter: number;
  llmCalls: number;
  elapsedMs: number;
  error: string | null;
}): LiveHuntState {
  const stages = safeJsonParse<LiveHuntStageRecord[]>(row.stages ?? "[]", []).filter(
    (s) => s && typeof s.key === "string"
  );
  return {
    id: row.id,
    status: row.status,
    stageKey: row.stageKey,
    done: row.status === "done",
    goal: row.goal,
    missionId: row.missionId ?? null,
    generation: row.generation,
    seededFrom: row.seededFrom ?? null,
    dnaBefore: row.dnaBefore,
    dnaAfter: row.dnaAfter,
    llmCalls: row.llmCalls,
    elapsedMs: row.elapsedMs,
    error: row.error,
    stages,
    stageOrder: LIVE_HUNT_STAGE_ORDER,
  };
}

/**
 * Run the next stage. Per-run lock — parallel calls are serialized.
 * The execute stage repeats itself until all mission phases have run.
 */
const huntLocks = new Map<number, Promise<unknown>>();

export function runNextLiveHuntStage(id: number): Promise<LiveHuntState> {
  const prev = huntLocks.get(id) ?? Promise.resolve();
  const gate = prev.catch(() => undefined).then(() => runNextLocked(id));
  huntLocks.set(id, gate);
  void gate.catch(() => undefined).finally(() => {
    if (huntLocks.get(id) === gate) huntLocks.delete(id);
  });
  return gate;
}

async function runNextLocked(id: number): Promise<LiveHuntState> {
  const row = await db.liveHunt.findUnique({ where: { id } });
  if (!row) throw new LiveHuntError("Hunt not found", 404);
  if (row.status === "done") return serializeLiveHunt(row);
  // Before: a "failed" hunt re-entering runNextLocked (the client didn't stop the pump)
  // re-ran the failed stage in an infinite loop — burning GitHub/LLM quota unattended.
  // Any new entry into a stage requires running status; a retry = an explicit retry.
  if (row.status === "failed") {
    // The failed state is attached to the error (.state) — the route returns it in the response body,
    // and the client pump reads it (payload.hunt) and stops instead of looping.
    const guardErr = new LiveHuntError("The hunt failed — an explicit retry is required", 409);
    throw Object.assign(guardErr, { state: serializeLiveHunt(row) });
  }

  const startedAt = Date.now();
  const doneStages = safeJsonParse<LiveHuntStageRecord[]>(row.stages ?? "[]", []).filter(
    (s) => s && typeof s.key === "string"
  );
  const ctx: HuntCtx = {
    id,
    done: doneStages,
    evidence: (key) => doneStages.find((s) => s.key === key)?.evidence ?? null,
    llmCallsSoFar: row.llmCalls,
    generation: row.generation,
    seededFrom: row.seededFrom ?? null,
  };

  const stageKey = row.stageKey;
  const title = LIVE_HUNT_STAGE_TITLES[stageKey] ?? stageKey;

  // Exact LLM measurement starts here: the zai.ts counter increments on every real SDK call attempt,
  // so the delta at stage end is precisely what this stage burned (see the llmDelta computation below).
  const llmCallsBefore = llmCallSnapshot();

  try {
    let result: { summary: string; evidence: Record<string, unknown>; stay?: boolean };
    switch (stageKey) {
      case "hunt":
        result = await stageHunt(ctx);
        break;
      case "swarm":
        result = await stageSwarm(ctx);
        break;
      case "attack":
        result = await stageAttack(ctx);
        break;
      case "mine":
        result = await stageMine(ctx);
        break;
      case "compile":
        result = await stageCompile(ctx);
        break;
      case "execute":
        result = await stageExecute(ctx);
        break;
      case "grow":
        result = await stageGrow(ctx);
        break;
      case "verdict":
        result = await stageVerdict(ctx);
        break;
      default:
        throw new LiveHuntError(`Unknown stage: ${stageKey}`, 400);
    }

    const rec: LiveHuntStageRecord = {
      key: stageKey,
      title,
      summary: result.summary,
      ms: Date.now() - startedAt,
      evidence: result.evidence,
    };

    // execute repeats — replaces the existing record instead of accumulating
    // (before: the last execute run didn't filter out the previous one — two execute
    //  records remained in the JSON, and the stage count in the campaign verdict was inflated by 1)
    const newDone =
      result.stay || stageKey === "execute"
        ? [...doneStages.filter((s) => s.key !== stageKey), rec]
        : [...doneStages, rec];

    let nextStageKey: string;
    if (result.stay) {
      nextStageKey = stageKey; // stay on execute until all phases complete
    } else {
      const idx = LIVE_HUNT_STAGE_ORDER.indexOf(stageKey as (typeof LIVE_HUNT_STAGE_ORDER)[number]);
      nextStageKey = idx >= 0 && idx + 1 < LIVE_HUNT_STAGE_ORDER.length ? LIVE_HUNT_STAGE_ORDER[idx + 1] : "done";
    }

    // Update missionId when known, goal when derived
    const missionIdFromEvidence = Number(result.evidence.missionId);
    const goalFromEvidence = typeof result.evidence.goal === "string" ? (result.evidence.goal as string) : null;

    const isFinished = nextStageKey === "done" && stageKey === "verdict";
    const dnaAfter = isFinished ? await db.dnaArtifact.count() : row.dnaAfter;
    // Exact LLM usage: counter delta between stage start and stage end — every real SDK attempt,
    // 429 retries included (the honest number for quota pressure). (Before: estimates — swarm/attack/grow
    // were read from per-stage evidence, compile was hardcoded 2, execute 1/phase — internal retries
    // were invisible and the total was only a lower bound.) One caveat, stated honestly: the counter is
    // process-global, so a manual flow racing this hunt (e.g. a mission compiled from the UI during the
    // execute stage) lands inside this stage's window; with the serial LLM queue that is rare in practice.
    const llmDelta = llmCallSnapshot() - llmCallsBefore;

    const updated = await db.liveHunt.update({
      where: { id },
      data: {
        stages: JSON.stringify(newDone),
        stageKey: isFinished ? "verdict" : nextStageKey,
        status: isFinished ? "done" : "running",
        missionId: Number.isInteger(missionIdFromEvidence) && missionIdFromEvidence > 0 ? missionIdFromEvidence : row.missionId,
        goal: goalFromEvidence ?? row.goal,
        dnaAfter,
        llmCalls: row.llmCalls + llmDelta,
        elapsedMs: row.elapsedMs + rec.ms,
      },
    });

    const state = serializeLiveHunt(updated);
    if (isFinished) {
      // Campaign verdict — growth proven in numbers
      state.done = true;
      // The chain is complete and the library may have grown (mined + born genes) — snapshot it
      // automatically in the background (the manual script required a human to remember).
      // Fire-and-forget: snapshot I/O must never delay or fail the verdict response.
      void writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));
    }
    return state;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const failed = await db.liveHunt.update({
      where: { id },
      data: { status: "failed", error: msg.slice(0, 500) },
    });
    console.error(`[live-hunt] stage ${stageKey} failed for hunt #${id}:`, e);
    // An AutopilotError with 4xx = a built-in problem — returned as-is; otherwise a server error
    const status = e instanceof LiveHuntError ? e.status : e instanceof AutopilotError ? e.status : 500;
    const err = new LiveHuntError(msg, status || 500);
    // Still return the full state in a field of the error via the API
    throw Object.assign(err, { state: serializeLiveHunt(failed) });
  }
}

/** Retry the current stage after a failure */
// round 8: the old body was check-then-act with no lock and an unconditional update —
// two parallel retry POSTs both read "failed", both passed, both flipped to running;
// and the active-check raced a concurrent startLiveHunt. Now: an in-process retry
// flag (same discipline as startingHunt) + a conditional updateMany (only a row still
// in "failed" flips) + an active check that excludes this hunt deterministically.
let retryingHunt = false;
export async function retryLiveHunt(id: number): Promise<LiveHuntState> {
  if (startingHunt || retryingHunt) {
    throw new LiveHuntError("A hunt start/retry is already in progress — one moment", 409);
  }
  retryingHunt = true;
  try {
    const row = await db.liveHunt.findUnique({ where: { id } });
    if (!row) throw new LiveHuntError("Hunt not found", 404);
    if (row.status !== "failed") throw new LiveHuntError("Only a failed hunt can be retried", 400);
    // Before: a retry without an active-run check broke the single-run rule — two running rows,
    // start stuck on 409 forever, and both chains competing for the LLM queue and GitHub quota.
    const active = await db.liveHunt.findFirst({
      where: { status: "running", id: { not: id } },
      select: { id: true },
      orderBy: { id: "desc" },
    });
    if (active) {
      throw new LiveHuntError(`Live hunt #${active.id} is already running — only one run at a time`, 409);
    }
    // conditional flip — a parallel retryer that won the race leaves count 0
    const cas = await db.liveHunt.updateMany({
      where: { id, status: "failed" },
      data: { status: "running", error: null },
    });
    if (cas.count === 0) {
      throw new LiveHuntError("Hunt state changed while retrying — refresh and retry", 409);
    }
    const updated = await db.liveHunt.findUnique({ where: { id } });
    if (!updated) throw new LiveHuntError("Hunt not found", 404);
    return serializeLiveHunt(updated);
  } finally {
    retryingHunt = false;
  }
}
