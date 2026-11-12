// ============================================================
// GitHub API client + "Claude Investment" scoring engine
// Server-side only helpers
// ============================================================

export const GH_API = "https://api.github.com";

export class GhError extends Error {
  status: number;
  /** true when the API explicitly said we hit a (primary/secondary) rate limit.
   *  Set at the source of truth (here) so rate-limit handling never depends on
   *  matching the *translated* message text — a past bug: the Hebrew message
   *  lost the "rate limit" substring and the backoff in deep-sweep/auditor
   *  never fired (queries failed permanently instead of waiting 8/16/32s). */
  rateLimited?: boolean;
  constructor(status: number, message: string, rateLimited = false) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
    this.name = "GhError";
  }
}

export function ghHeaders(
  token?: string | null,
  accept = "application/vnd.github+json"
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "claude-hunter-app",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// ---------- quota-header awareness ----------

/** Last quota snapshot seen on ANY GitHub response (module-level — process-wide).
 *  GitHub stamps x-ratelimit-* on every reply, including the 403/429 that says
 *  we ran out. Remembering them lets callers wait until the REAL window reset
 *  instead of sleeping blind (the old fixed 8/16/32s ladder burned retries when
 *  the reset was minutes away) and pace themselves before the cliff, not after. */
const lastQuota = { remaining: null as number | null, reset: null as number | null, resource: null as string | null };

export function getQuotaState() {
  return { ...lastQuota };
}

/** Reads the quota headers into lastQuota. Must be called immediately after fetch
 *  resolves — BEFORE res.json()/res.text() consumes the body — so the timing of the
 *  read is obvious and can never drift behind a body-parse refactor. */
function readQuotaHeaders(res: Response): void {
  const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "", 10);
  const reset = parseInt(res.headers.get("x-ratelimit-reset") ?? "", 10);
  const resource = res.headers.get("x-ratelimit-resource");
  // parseInt on a missing/garbage header yields NaN — only a parseable value may
  // overwrite the known state, otherwise one bad reply would erase good intel.
  if (Number.isFinite(remaining)) lastQuota.remaining = remaining;
  if (Number.isFinite(reset)) lastQuota.reset = reset;
  if (resource) lastQuota.resource = resource;
}

export async function ghFetch<T = unknown>(
  path: string,
  token?: string | null,
  accept?: string
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  // timeout against hanging connections — previously: sweep/audit hung forever on a dead TCP
  const res = await fetch(url, {
    headers: ghHeaders(token, accept),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  // Quota snapshot before anything else — even a 403 carries the headers that
  // tell ghSearchWithBackoff how long the window REALLY takes to reset.
  readQuotaHeaders(res);
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      // keep default message
    }
    // Rate-limit detection happens HERE (source of truth) and is exposed as a
    // flag — the message shown to the user stays freely editable text, while
    // the machine-readable signal never depends on message language again.
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection/i.test(msg);
    if (isRateLimit) {
      msg = "GitHub API rate limit exhausted. Add a Personal Access Token in settings to continue.";
    }
    if (res.status === 401) {
      msg = "The token you provided is invalid or has expired.";
    }
    throw new GhError(res.status, msg, isRateLimit);
  }
  return (await res.json()) as T;
}

/**
 * Fetch raw content — files, README, SKILL.md, etc.
 * Different from ghFetch: returns text, not JSON.
 */
export async function ghFetchRaw(
  path: string,
  token?: string | null,
  accept = "application/vnd.github.raw"
): Promise<string> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const res = await fetch(url, {
    headers: ghHeaders(token, accept),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  // Same quota snapshot as ghFetch — raw downloads drain the same core pool
  readQuotaHeaders(res);
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      // keep default message
    }
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection/i.test(msg);
    if (isRateLimit) {
      msg = "GitHub API rate limit exhausted. Add a Personal Access Token in settings to continue.";
    }
    if (res.status === 401) {
      msg = "The token you provided is invalid or has expired.";
    }
    throw new GhError(res.status, msg, isRateLimit);
  }
  return await res.text();
}

// ---------- input parsing ----------

/**
 * A capability file path (SKILL.md / .claude/commands / agents) — single source.
 * It used to be defined word-for-word identically in two files (deep-sweep + harvester)
 * and drifted with every fix.
 */
export function isCapabilityPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("skill.md") ||
    p.includes(".claude/commands/") ||
    p.includes(".claude/agents/") ||
    p === "claude.md" ||
    p === "agents.md"
  );
}

export function parseRepoInput(raw: string): { owner: string; repo: string } | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\.git$/i, "");
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^github\.com\//i, "");
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

// ---------- Claude model registry (REAL models only) ----------
// Source of truth: src/lib/claude-models.ts — the real 4.x family IS the premium
// tier (Opus 4.5 = the strongest that exists); fictional strings are contamination.
export {
  MIN_QUALIFYING_VERSION,
  THRESHOLD_LABEL,
  THRESHOLD_RULE_TEXT,
  QUALIFYING_MODELS,
  classifyVersion,
  detectClaudeModels,
  detectModelFieldValue,
  isBlockedModelString,
  qualifyingModelOptions,
} from "./claude-models";
import { detectClaudeModels, type ClaudeModelDef } from "./claude-models";

// ---------- tier system ----------

import type { TierKey } from "./hunter-types"; // single source — used to be defined identically in two files
export type { TierKey }; // re-export for existing github.ts consumers

export const TIERS: { min: number; key: TierKey; label: string; emoji: string }[] = [
  { min: 80, key: "elite", label: "Elite", emoji: "💎" },
  { min: 60, key: "gold", label: "Gold", emoji: "🥇" },
  { min: 40, key: "silver", label: "Silver", emoji: "🥈" },
  { min: 20, key: "bronze", label: "Bronze", emoji: "🥉" },
  { min: 0, key: "seed", label: "Seed", emoji: "🌱" },
];

export function tierOf(score: number): { key: TierKey; label: string; emoji: string } {
  return TIERS.find((t) => score >= t.min) ?? TIERS[TIERS.length - 1];
}

// ---------- GraphQL + shared concurrency pool ----------

/**
 * GraphQL call — one round-trip replaces dozens of REST calls.
 * Live-verified: the REST code-search "repository" object does NOT include
 * stargazers_count/pushed_at, which forced the old per-repo /repos/ enrichment
 * (25-30 calls per harvest/sweep). With aliases we now batch up to 50 repos
 * (stars + pushedAt + defaultBranchRef) in ONE request at a cost of 1 point
 * from the same 5000/hour pool.
 */
export async function ghGraphql<T = unknown>(
  query: string,
  token?: string | null
): Promise<T> {
  const res = await fetch(`${GH_API}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  // Same quota snapshot as ghFetch — GraphQL shares the 5000/hour core pool
  readQuotaHeaders(res);
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string; errors?: { message?: string }[] };
      msg = j?.message ?? j?.errors?.[0]?.message ?? msg;
    } catch {
      // keep default
    }
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection/i.test(msg);
    if (isRateLimit) msg = "GitHub API rate limit exhausted. Add a Personal Access Token in settings to continue.";
    if (res.status === 401) msg = "The token you provided is invalid or has expired.";
    throw new GhError(res.status, msg, isRateLimit);
  }
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  // GraphQL can return 200 with an errors array (e.g. bad alias, too deep) —
  // surface the first error instead of silently returning partial data.
  if (body.errors?.length) {
    throw new GhError(200, body.errors[0]?.message ?? "GraphQL error", false);
  }
  return body.data as T;
}

/** Bounded concurrency for parallel fetch bursts — raw content downloads,
 *  enrichment, anything that could trip GitHub's secondary rate limits when
 *  fired as one big Promise.all. Process-wide reuse. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- shared search backoff (single source of truth) ----------

const ghSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Search call with rate-limit recovery. Exists ONCE (used to be duplicated in
 * deep-sweep and auditor — one copy had a dead backoff because it matched the
 * English "rate limit" inside a message that was already translated to Hebrew).
 * Policy: 403/429 marked as rate-limit by ghFetch (GhError.rateLimited) → wait
 * until the quota window actually resets (from the x-ratelimit-reset header the
 * rate-limited response itself carried — see readQuotaHeaders) and retry; any
 * other error (private repo, bad token…) is thrown immediately so we don't burn
 * a minute on a query that can never succeed.
 */
export async function ghSearchWithBackoff<T>(path: string, token: string | null): Promise<T> {
  const delays = [8_000, 16_000, 32_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await ghFetch<T>(path, token);
    } catch (e) {
      lastErr = e;
      const rl = e instanceof GhError && (e.status === 403 || e.status === 429) && (e.rateLimited === true || /rate limit|secondary/i.test(e.message));
      if (!rl || attempt === delays.length) throw e;
      // Header-aware wait: sleep exactly until the window resets (+1s of grace).
      // The fixed ladder is kept as the fallback when no reset epoch was ever
      // seen (e.g. a proxy stripped the headers). Clamped to [8s, 120s]: a reset
      // already in the past still gets the minimum breather, and a corrupt
      // future epoch can never hang the sweep for hours. Retry-count semantics
      // are unchanged — still at most 3 retries.
      let waitMs = delays[attempt];
      if (lastQuota.reset != null) {
        const tillResetMs = (lastQuota.reset - Math.floor(Date.now() / 1000) + 1) * 1000;
        waitMs = Math.min(120_000, Math.max(8_000, tillResetMs));
      }
      await ghSleep(waitMs);
    }
  }
  throw lastErr;
}

// ---------- scoring helpers ----------

/** Log-saturated score: 0..max, saturating at `saturateAt` */
export function satScore(value: number, max: number, saturateAt: number): number {
  if (!value || value <= 0) return 0;
  const v = Math.min(value, saturateAt);
  return Math.round((Math.log10(v + 1) / Math.log10(saturateAt + 1)) * max);
}

export interface RepoLike {
  fullName?: string;
  description?: string | null;
  stars: number;
  forks: number;
  topics?: string[];
  pushedAt?: string;
}

/**
 * Detects only qualifying models (≥5.5). 4.x-and-below models are not returned
 * here — use detectClaudeModels for the full separation including blocked ones.
 */
export function detectModelsInText(text: string): ClaudeModelDef[] {
  return detectClaudeModels(text).qualifying;
}

const CLAUDE_HINT = /\bclaude\b|claude[-_ ]?code|anthropic/i;
const MCP_HINT = /\bmcp\b|mcp[-_ ]?server|model context protocol/i;
const AGENT_HINT = /\bagent|agentic|multi-agent/i;

/** Lightweight score for list results (no extra API calls) */
export function computeListScore(repo: RepoLike): {
  score: number;
  tier: TierKey;
  reasons: string[];
  /** true if only blocked models (4.x and below) were detected and no qualifying one — disqualified under the threshold rule */
  blockedOnly: boolean;
} {
  const reasons: string[] = [];
  let score = 0;

  const traction = satScore(repo.stars, 20, 10000) + satScore(repo.forks, 6, 1000);
  score += traction;
  if (repo.stars > 0) reasons.push(`⭐ ${repo.stars.toLocaleString()} stars`);

  if (repo.pushedAt) {
    const days = (Date.now() - new Date(repo.pushedAt).getTime()) / 86400000;
    if (days < 7) { score += 8; reasons.push("Very active (7 days)"); }
    else if (days < 30) { score += 6; reasons.push("Updated this month"); }
    else if (days < 90) { score += 4; reasons.push("Updated in the last quarter"); }
    else if (days < 365) { score += 2; }
  }

  const hay = [repo.fullName, repo.description, (repo.topics ?? []).join(" ")].filter(Boolean).join(" ");
  let hints = 0;
  if (/\bclaude\b|claude[-_ ]?code/i.test(hay)) { hints += 6; reasons.push("Claude detected"); }
  if (/anthropic/i.test(hay)) { hints += 5; reasons.push("Anthropic detected"); }
  if (MCP_HINT.test(hay)) { hints += 3; reasons.push("MCP mention"); }
  if (AGENT_HINT.test(hay)) { hints += 3; reasons.push("Agents mention"); }
  const detection = detectClaudeModels(hay);
  if (detection.qualifying.length > 0) {
    hints += 6;
    reasons.push(`🧠 Real premium models: ${detection.qualifying.map((m) => m.label).join(", ")}`);
  }
  if (detection.fiction.length > 0 && detection.qualifying.length > 0) {
    reasons.push(`⚠️ Mixed: real models + fictional pins (${detection.fiction.map((f) => f.label).join(", ")}) — partial contamination`);
  } else if (detection.fictionOnly) {
    // ⚠️ Only fictional model strings — hallucination contamination, negative trust
    hints -= 5;
    reasons.push(`⚠️ Fictional model pins only (${detection.fiction.map((f) => f.label).join(", ")}) — hallucination contamination`);
  } else if (detection.blockedOnly) {
    // ⛔ Only ancient models (claude-2 era) — zero model points + a block tag
    reasons.push(`⛔ Only ${detection.blocked.map((b) => b.label).join(", ")} models (ancient era — worthless as a 2026 target)`);
  }
  score += Math.min(hints, 18);

  const total = Math.max(0, Math.min(100, score));
  return { score: total, tier: tierOf(total).key, reasons, blockedOnly: detection.blockedOnly };
}
