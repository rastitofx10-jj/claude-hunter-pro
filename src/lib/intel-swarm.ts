// ============================================================
// Prompt swarm — multi-stage deep intelligence
// Instead of one generic prompt: 8 professional prompts with expert roles —
// evidence triage ← investment profiles ← market patterns ← attack plan
// ← query evolution ← executive briefing.
// Each prompt returns strict JSON with a correction chain. Server-side only.
// ============================================================

import { extractJson, isTimeoutError, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";
import { db } from "./db";
import { detectClaudeModels } from "./claude-models";
import { detectEmergingModels } from "./emerging-models";
import type { CandidateFlat } from "./deep-sweep";

export class SwarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmError";
  }
}

const TIMEOUT_MS = 110_000;

const SWARM_ROLE = `You are a senior intelligence officer in a technology-hunting unit. You are sharp, skeptical, and evidence-based.
Iron rules:
1. You are a JSON engine — return valid JSON and nothing beyond it. No code fences, no explanations.
2. English only (technical terms stay in English within the text).
3. Never invent. No evidence? Write that none was found. Be skeptical of weak evidence.
4. Model truth: only REAL Anthropic models count — Opus 4.5 is the strongest model that exists today; Sonnet 4.5 / Haiku 4.5 follow; older real models are worth proportionally less. "Fable", "opus 5.5", "opus 6" and anything above the real 4.5 frontier are FICTIONAL hallucinated strings — flag them as contamination, zero credit.
5. Inside string values, double quotes (") are forbidden — use single quotes (').`;

const RETRY_HINT = `\n\n⚠️ Correction: the previous answer was not valid JSON. Return the same content as tight JSON — no double quotes inside values, no dangling commas, JSON body only.`;

async function llmJson(userPrompt: string): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The global queue in zai.ts serializes all AI calls in the process (concurrency 1)
      // — two engines running together (chimney during a sweep) no longer take each other
      // down with 429s. role:"system" — the system instructions get real priority.
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: SWARM_ROLE },
          { role: "user", content: attempt === 0 ? userPrompt : userPrompt + RETRY_HINT },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "AI call", timeoutError: SwarmError }
      );
      if (!raw.trim()) {
        lastErr = new SwarmError("The AI returned an empty answer");
        continue;
      }
      return extractJson(raw, SwarmError);
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — no retry, 8+ prompts × 110 seconds = a trap
      if (e instanceof SwarmError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new SwarmError("A prompt failed");
}

// ---------- Fishing helpers ----------

function candidateLine(c: CandidateFlat, i: number): string {
  const provenance =
    c.contentEvidence.length > 0
      ? `hard-verified (the string inside a real file's content: ${c.contentEvidence.join(", ")})`
      : c.textEvidence.length > 0
        ? `soft only (just a mention in description/topics, not proven in code: ${c.textEvidence.join(", ")})`
        : "weak (a generic claude mention)";
  return [
    `[${i}] ${c.fullName}`,
    `⭐${c.stars} · last push: ${c.pushedAt?.slice(0, 10) ?? "??"} · evidence: ${provenance}`,
    c.contentEvidence.length > 0 && c.evidencePaths.length > 0
      ? `evidence files in a real repo: ${c.evidencePaths.slice(0, 3).join(" | ")}`
      : "",
    c.description ? `description: ${c.description.slice(0, 200)}` : "description: none",
    c.capabilityHits ? `capability files discovered: ${c.capabilityHits}` : "",
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

// ---------- P1+P2: triage ----------

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
    // The contract language is English (elite|watch|noise); legacy Hebrew fallbacks were removed with the Hebrew contract.
    // round 8: substring matching made "not elite" → ELITE — an explicitly rejected
    // candidate got elite status, mining priority, and audit attention. Exact token
    // first; the substring chain stays only as a fallback for decorated answers,
    // with negated forms excluded.
    const verdict: TriageVerdict["verdict"] =
      v === "elite" ? "elite"
      : v === "watch" ? "watch"
      : v === "noise" ? "noise"
      : /\belite\b/.test(v) && !/\b(?:not|non|never|no|anti)\s+elite\b/.test(v) ? "elite"
      : /\bwatch\b/.test(v) ? "watch"
      : "noise";
    const conf = Number(o.confidence ?? o.confidenceScore ?? 50);
    out.push({
      fullName,
      verdict,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : 50,
      reason: str(o.reason ?? o.why, "no reasoning given"),
    });
  }
  return out;
}

/** Triage prompt — returns a verdict for every candidate in the batch */
export async function triageBatch(batch: CandidateFlat[]): Promise<TriageVerdict[]> {
  const list = batch.map((c, i) => candidateLine(c, i)).join("\n---\n");
  const prompt = `A list of candidates from a GitHub sweep (real-model truth gate):

${list}

Perform a comparative intelligence triage. The rules:
— "Hard-verified" evidence = the string was found inside a real file's content — a necessary condition for elite, but not sufficient.
— elite = only the truly strongest against the goal: proven monetary investment in REAL premium models (Opus 4.5 class) and real .claude capabilities. If all candidates look similar, rank them against each other and give elite only to the strongest third — the rest watch, with reasoning about what they lack.
— "Soft" evidence = a mention in the description only — elite is forbidden, watch at most. You must not claim the model was used in code.
— No evidence = noise.
— Marking the entire list elite is forbidden. Real spread: if you judged again and again and everyone is always elite — your triage is worthless.
Return exactly this JSON:
{"verdicts": [{"fullName": "owner/name", "verdict": "elite|watch|noise", "confidence": 0-100, "reason": "a short reasoning in English stating exactly where the evidence comes from (code content / description) and why it is strong/weak relative to the others"}]}`;
  const j = await llmJson(prompt);
  return parseTriage(j, batch);
}

// ---------- P3+P4: sharp investment profiles ----------

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
      moneyLevel: str(o.moneyLevel, "unknown"),
      signature: str(o.signature ?? o.whatTheyBuilt),
      stealThis: strArr(o.stealThis, 3),
      blindSpot: str(o.blindSpot ?? o.weakness),
    });
  }
  return out;
}

/** Profiles prompt — for top-tier candidates only */
export async function sharpProfiles(batch: CandidateFlat[]): Promise<SharpProfile[]> {
  const list = batch.map((c, i) => candidateLine(c, i)).join("\n---\n");
  const prompt = `The top of the sweep — candidates with the hardest evidence of investment in real premium Claude models:

${list}

Build a sharp investment profile for each one. Based on the evidence only:
{"profiles": [{"fullName": "owner/name", "investment": 0-100, "moneyLevel": "certain|likely|weak|unknown", "signature": "what they built there that requires a premium model", "stealThis": ["what to steal for our product"], "blindSpot": "what they don't see and we do"}]}`;
  const j = await llmJson(prompt);
  return parseProfiles(j, batch);
}

// ---------- P5: market patterns ----------

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
  const prompt = `The market picture from the sweep — elite (${elite.length}) + watch (${watch.length}):

${list}

Find cross-repo patterns: what are people building with the real premium models (Opus 4.5 / Sonnet 4.5)? Which product types are paying? Where is the market heading?
{"patterns": [{"pattern": "pattern name", "repos": ["owner/name"], "insight": "what it means for our product"}], "stackConsensus": ["recurring technologies"], "marketShift": "2-3 sentences: where the premium-Claude-usage market is heading"}`;
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
    marketShift: str(j.marketShift, "No market judgment received"),
  };
}

// ---------- P6: attack plan ----------

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
        `${p.fullName}: investment ${p.investment}/100 (${p.moneyLevel}) — signature: ${p.signature.slice(0, 150)}${
          p.blindSpot ? ` · blind spot: ${p.blindSpot.slice(0, 150)}` : ""
        }`
    )
    .join("\n");
  const patList = patterns.patterns.map((p) => `— ${p.pattern}: ${p.insight.slice(0, 150)}`).join("\n");
  const prompt = `You are building a competing AI interface. Here is the intelligence from the sweep:

Investment profiles:
${profList || "no profiles"}

Market patterns:
${patList || "no patterns"}

Formulate a ruthless, focused attack plan:
{"topMoves": [{"move": "the move", "why": "based on which intelligence", "effort": "low|medium|high"}], "differentiators": ["what no competitor has done"], "immediateActions": ["steps for the next 48 hours"]}`;
  const j = await llmJson(prompt);
  const movesRaw = Array.isArray(j.topMoves) ? j.topMoves : [];
  return {
    topMoves: movesRaw
      .map((m) => {
        const o = (m ?? {}) as Record<string, unknown>;
        const move = str(o.move ?? o.action ?? o.title);
        if (!move) return null;
        return { move, why: str(o.why ?? o.reason), effort: str(o.effort, "medium") };
      })
      .filter((m): m is AttackPlan["topMoves"][number] => !!m)
      .slice(0, 8),
    differentiators: strArr(j.differentiators, 6),
    immediateActions: strArr(j.immediateActions, 8),
  };
}

// ---------- P7: query evolution ----------

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
    .map((r) => `— [${r.error ? `error: ${String(r.error).slice(0, 60)}` : `${r.count} results`}] ${r.q}`)
    .join("\n");
  const dead = executedQueries.filter((r) => !r.error && r.count === 0).slice(0, 8);
  const deadList = dead.map((r) => r.q).join(" | ") || "none";
  const prompt = `We ran the following queries on GitHub — with each one's real result count:
${perQuery}

And we found ${elite.length} elite repos: ${elite.slice(0, 15).map((c) => c.fullName).join(", ") || "none"}

Strict rules:
1. A query with 0 results is dead — its pattern must not be repeated. Already identified dead ones: ${deadList}
2. Inventing repo:owner/name qualifiers is forbidden — an owner/name is legal only from the real elite list above, and only if you want to drill deeper into a specific repo.
3. A query returning hundreds of thousands of results is more noise than signal — narrow it with specific evidence words (e.g. file names, config strings, environment variable names) that exist in the code of real premium-model consumers.
4. Aim for 8-12 queries, each expected to return 5-200 quality results.

Propose the next round: which GitHub queries will expose what we missed?
{"nextQueries": ["8-12 new queries in GitHub syntax (code/repo search), focused even more sharply on evidence of real premium models"], "blindSpots": ["what the current sweep does not see"], "rationale": "why these in particular"}`;
  const j = await llmJson(prompt);
  // round 8 — the second truth-gate layer for evolved queries (same discipline as the
  // chimera gate, born after chimera #5): the prompt clause was the ONLY barrier on
  // this path. A hallucinated "claude-opus-5-5 filename:CLAUDE.md" passed every check in
  // validateEvolvedQueries (length / repo: validity / dead-pattern / duplicates), was
  // persisted into SweepRun.briefing and hunt evidence, DISPLAYED in the sweep UI —
  // and EXECUTED in generation 2+, burning the scarce code-search quota hunting a
  // fiction. Now: every query passes detectClaudeModels; fiction minus authority-
  // confirmed waves is dropped here, with the reason recorded so the briefing shows it.
  // Round 9 — UNKNOWN families join the gate: a hallucinated new-family id
  // (claude-nova-5-0 — zero detectClaudeModels hits, the radar's "candidate" class)
  // passed the filter and was persisted/displayed. Candidate-kind emerging signals
  // minus confirmed waves now drop exactly like known-family fiction.
  const confirmedWaves = await authorityConfirmedWaveIds().catch(() => new Set<string>());
  const rawQueries = strArr(j.nextQueries, 12);
  const dropped: string[] = [];
  const nextQueries = rawQueries.filter((q) => {
    const fiction = detectClaudeModels(q).fiction.map((f) => f.id).filter((id) => !confirmedWaves.has(id));
    const unknownFamily = detectEmergingModels(q)
      .map((s) => s.id)
      .filter((id) => !confirmedWaves.has(id));
    const bad = [...fiction, ...new Set(unknownFamily)];
    if (bad.length > 0) {
      dropped.push(`"${q}" (${bad.join(", ")})`);
      return false;
    }
    return true;
  });
  return {
    nextQueries,
    blindSpots: [...strArr(j.blindSpots, 6)],
    rationale:
      str(j.rationale) +
      (dropped.length
        ? ` [truth gate: ${dropped.length} proposed query(ies) dropped — fictional/unconfirmed model ids: ${dropped.join("; ")}]`
        : ""),
  };
}

/** Fiction ids the radar has authority-confirmed as REAL waves (org:anthropics hit) —
 *  those may be hunted; they are not contamination. (Same source as the genesis gate.) */
async function authorityConfirmedWaveIds(): Promise<Set<string>> {
  const row = await db.setting.findUnique({ where: { key: "frontierLedger" } });
  if (!row) return new Set();
  try {
    const entries = JSON.parse(row.value) as Array<{ id?: string; confirmed?: boolean }>;
    if (!Array.isArray(entries)) return new Set();
    return new Set(entries.filter((e) => e?.confirmed && typeof e.id === "string").map((e) => e.id as string));
  } catch {
    return new Set(); // an unreadable ledger never widens the filter
  }
}

// ---------- P8: executive briefing ----------

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
  const prompt = `Close the operation with a one-page executive briefing.

Operation stats: ${input.statsLine}
Elite repos: ${input.eliteCount}
New DNA mined: ${input.dnaAdded}

Patterns: ${input.patterns.patterns.map((p) => p.pattern).join("; ") || "none"}
Leading moves: ${input.attack.topMoves.map((m) => m.move).slice(0, 5).join("; ") || "none"}

{"headline": "one headline summarizing the campaign's finding", "keyIntel": ["3-5 critical findings"], "decisiveMove": "the single decisive move for the coming week", "riskMap": ["risks and threats"]}`;
  const j = await llmJson(prompt);
  return {
    headline: str(j.headline, "No headline received"),
    keyIntel: strArr(j.keyIntel, 6),
    decisiveMove: str(j.decisiveMove),
    riskMap: strArr(j.riskMap, 6),
  };
}

// ---------- Full swarm run ----------

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
 * Full run: 8 prompts (2 triage + 2 profiles + patterns + attack + queries + briefing).
 * Forgiving of partial failures: a failed prompt doesn't take down the operation — it's recorded in failures.
 * executedQueries must be {q,count,error} objects — before, the signature declared string[]
 * and anyone passing strings caused "undefined results" in the query-evolution prompt
 * and a permanently empty dead-queries list (a real bug closed here at the type level).
 */
/** Triage coverage — the number of findings that receive a verdict from the swarm.
 * Exported so the guard and the saved findings always sum to the same number — before,
 * 60 findings were saved when only 36 got a verdict, and rows 37-60 showed "pending" forever. */
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

  // Triage in batches of 12
  const batches = chunk(candidates.slice(0, SWARM_TRIAGE_COVERAGE), 12);
  const triage: TriageVerdict[] = [];
  // Round 9 — honest totals: the OLD `batches.length * 2 + 4` assumed profile
  // batches == triage batches, but elite is capped at 12 (≤2 profile batches of 6):
  // with 1 triage batch the progress showed 7/6, with 2 it ended at 9/10 — never 100%.
  // During triage the honest upper bound is batches + 2 profile batches + 4 singles;
  // once elite is known the exact total replaces it for the rest of the run.
  const estTotalPrompts = batches.length + 2 + 4;
  let totalPrompts = estTotalPrompts;

  for (const batch of batches) {
    try {
      calls++;
      triage.push(...(await triageBatch(batch)));
    } catch (e) {
      failures.push(`triage: ${e instanceof Error ? e.message : "error"}`);
    }
    await onProgress?.(calls, estTotalPrompts);
  }

  const eliteNames = new Set(triage.filter((t) => t.verdict === "elite").map((t) => t.fullName));
  const elite = candidates.filter((c) => eliteNames.has(c.fullName)).slice(0, 12);
  totalPrompts = batches.length + Math.ceil(elite.length / 6) + 4;
  const watchNames = new Set(triage.filter((t) => t.verdict === "watch").map((t) => t.fullName));
  const watch = candidates.filter((c) => watchNames.has(c.fullName)).slice(0, 12);

  // Profiles — elite only, in batches of 6
  const profiles: SharpProfile[] = [];
  for (const batch of chunk(elite, 6)) {
    try {
      calls++;
      profiles.push(...(await sharpProfiles(batch)));
    } catch (e) {
      failures.push(`profiles: ${e instanceof Error ? e.message : "error"}`);
    }
    await onProgress?.(calls, totalPrompts);
  }

  const safePatterns: MarketPatterns = { patterns: [], stackConsensus: [], marketShift: "" };
  let patterns = safePatterns;
  try {
    calls++;
    patterns = await patternSynthesis(elite, watch);
  } catch (e) {
    failures.push(`patterns: ${e instanceof Error ? e.message : "error"}`);
  }
  await onProgress?.(calls, totalPrompts);

  const safeAttack: AttackPlan = { topMoves: [], differentiators: [], immediateActions: [] };
  let attack = safeAttack;
  try {
    calls++;
    attack = await attackPlan(elite, profiles, patterns);
  } catch (e) {
    failures.push(`attack plan: ${e instanceof Error ? e.message : "error"}`);
  }
  await onProgress?.(calls, totalPrompts);

  let queries: QueryEvolution = { nextQueries: [], blindSpots: [], rationale: "" };
  try {
    calls++;
    queries = await queryEvolution(executedQueries, elite);
  } catch (e) {
    failures.push(`query evolution: ${e instanceof Error ? e.message : "error"}`);
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
    failures.push(`briefing: ${e instanceof Error ? e.message : "error"}`);
  }
  await onProgress?.(calls, totalPrompts);

  return { triage, profiles, patterns, attack, queryEvolution: queries, brief, llmCalls: calls, llmFailures: failures };
}
