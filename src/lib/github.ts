// ============================================================
// GitHub API client + "Claude Investment" scoring engine
// Server-side only helpers
// ============================================================

import { createHash } from "node:crypto";
import { emitRate } from "./event-bus";

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

// ---------- TTL memory cache for slow-moving reads ----------

// History: every ghFetch went out with cache:"no-store" — correct for search
// and file content, but repo enrichment, the contributors/languages breakdowns
// and the quota ping re-read the SAME slow-moving documents many times per
// sweep, paying a real point from the 5000/hour core pool each time. Idempotent
// GET reads of slow-moving data are now memoized per
// (method + full url + accept + token-hash) with a pattern-based TTL:
//   /rate_limit                  →  30s  (the quota ping itself costs a point; sub-minute staleness is fine)
//   /repos/{owner}/{repo}        →  10min (stars/description move on a day scale)
//   /repos/{o}/{r}/languages     →  30min (a language list changes ~never)
//   /repos/{o}/{r}/contributors  →  30min (top contributors drift slowly)
// Deliberately NEVER cached: /search/* (freshness IS the product), ghFetchRaw
// (file content IS the product — a stale SKILL.md would poison the DNA
// library; that function is simply not wired to this cache), GraphQL (a POST
// — the cache is GET-only by construction), and anything carrying a body or a
// non-GET method. 4xx/5xx replies are never stored — a cached failure would
// stretch a transient 403 into a TTL-long outage. Bounded at 200 entries,
// evicting the oldest by insertion order (Map) so memory stays sane even under
// a pathological caller mix.

interface GhCacheEntry {
  storedAt: number;
  ttlMs: number;
  // always 2xx here (every failure throws before the store) — kept for
  // self-documenting hits. Headers are deliberately NOT kept: ghFetch's
  // contract is parsed JSON, and replaying stale x-ratelimit-* headers into
  // the live quota state on a hit would corrupt the freshest intel the app
  // has — the backoff engine would then wait on yesterday's reset epoch.
  status: number;
  bodyJson: unknown;
}

const GH_CACHE_MAX = 200;
const ghCache = new Map<string, GhCacheEntry>();

/** Token → opaque hash. The raw PAT must never sit inside a cache key: keys
 *  end up in stack traces and heap dumps far more easily than header values do. */
function ghTokenHash(token: string | null | undefined): string {
  return createHash("sha1").update(`gh:${token ?? ""}`).digest("hex").slice(0, 12);
}

function ghCacheKey(url: string, token: string | null | undefined, accept: string): string {
  // accept rides in the key (beyond the spec's method+url+token) because the
  // same URL can legally return different representations per Accept header —
  // no caller varies it today, but the collision would be completely silent if
  // one ever did.
  return `GET:${url}:${accept}:${ghTokenHash(token)}`;
}

/** TTL for cacheable URL shapes; 0 = always-live. Patterns are anchored so
 *  /repos/o/r/contents/... or /search/... can never sneak into a slow tier. */
function ghCacheTtlMs(url: string): number {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 0; // an unparseable URL has bigger problems — the fetch below will speak up
  }
  if (pathname === "/rate_limit") return 30_000;
  if (/^\/repos\/[^/]+\/[^/]+\/languages\/?$/.test(pathname)) return 30 * 60_000;
  if (/^\/repos\/[^/]+\/[^/]+\/contributors\/?$/.test(pathname)) return 30 * 60_000;
  if (/^\/repos\/[^/]+\/[^/]+\/?$/.test(pathname)) return 10 * 60_000;
  return 0;
}

function ghCacheGet(key: string): GhCacheEntry | null {
  const hit = ghCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > hit.ttlMs) {
    ghCache.delete(key); // expired entries leave the map — the 200-cap is for LIVE entries
    return null;
  }
  return hit;
}

function ghCacheSet(key: string, status: number, bodyJson: unknown, ttlMs: number): void {
  let safeCopy: unknown;
  try {
    // the stored copy must be immune to caller mutation (a consumer rewriting
    // a field of the result it got) — and every hit hands out a fresh clone, so
    // two callers must never share one mutable object through the cache.
    safeCopy = structuredClone(bodyJson);
  } catch {
    return; // exotic payload — don't cache what we can't safely hand out later
  }
  ghCache.delete(key); // re-store refreshes insertion order → eviction stays "stalest first"
  ghCache.set(key, { storedAt: Date.now(), ttlMs, status, bodyJson: safeCopy });
  while (ghCache.size > GH_CACHE_MAX) {
    const oldest = ghCache.keys().next().value;
    if (oldest === undefined) break;
    ghCache.delete(oldest);
  }
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

// ---------- quota events on the bus ----------

// Every REST reply carries x-ratelimit-*, so an unconditional emit would flood
// the SSE stream with hundreds of identical readings per sweep. The bus gets a
// reading ONLY when the observed remaining for that pool (core vs search —
// they reset at different hours) actually moved since the last emit, tracked
// per pool in a module-level memo. The 403/429 exhaustion reply deliberately
// passes the filter too: its remaining=0 differs from the last reading by
// definition, so the exact moment a pool runs dry is always on the record —
// the single most valuable quota event, and requiring res.ok would hide it.
const lastEmittedRate = {
  coreRemaining: null as number | null,
  coreLimit: null as number | null,
  searchRemaining: null as number | null,
  searchLimit: null as number | null,
};

function emitRateIfChanged(res: Response, resource: string | null, remaining: number): void {
  if (resource !== "core" && resource !== "search") return; // graphql/unknown pools aren't part of the core/search panel
  if (!Number.isFinite(remaining)) return; // an unparseable header is not a reading
  const limit = parseInt(res.headers.get("x-ratelimit-limit") ?? "", 10);
  const lim = Number.isFinite(limit) ? limit : null;
  const remKey = resource === "core" ? "coreRemaining" : "searchRemaining";
  const limKey = resource === "core" ? "coreLimit" : "searchLimit";
  if (lastEmittedRate[remKey] === remaining && lastEmittedRate[limKey] === lim) return; // nothing moved — stay quiet
  lastEmittedRate[remKey] = remaining;
  if (lim !== null) lastEmittedRate[limKey] = lim;
  // both pools' latest known numbers ride along, so each event is a full panel
  // snapshot instead of a delta the frontend would have to merge
  emitRate({
    coreRemaining: lastEmittedRate.coreRemaining ?? undefined,
    coreLimit: lastEmittedRate.coreLimit ?? undefined,
    searchRemaining: lastEmittedRate.searchRemaining ?? undefined,
    searchLimit: lastEmittedRate.searchLimit ?? undefined,
  });
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
  // and every parseable reading is offered to the bus — change-detected inside
  emitRateIfChanged(res, resource, remaining);
}

export async function ghFetch<T = unknown>(
  path: string,
  token?: string | null,
  accept?: string
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  // TTL cache — slow-moving idempotent reads only (see ghCacheTtlMs). A hit
  // returns a fresh clone of the stored body: the caller gets its own mutable
  // object, and NO quota headers are replayed (a cached reply carries the
  // quota numbers of when it was stored — feeding those into lastQuota would
  // be a lie the backoff engine would then act on).
  const ttlMs = ghCacheTtlMs(url);
  const cacheKey = ttlMs > 0 ? ghCacheKey(url, token, accept ?? "application/vnd.github+json") : null;
  if (cacheKey) {
    const hit = ghCacheGet(cacheKey);
    if (hit) return structuredClone(hit.bodyJson) as T;
  }
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
  const bodyJson = (await res.json()) as T;
  // stored only for 2xx cacheable reads — every failure threw above, and a
  // non-cacheable URL never got a key in the first place
  if (cacheKey) ghCacheSet(cacheKey, res.status, bodyJson, ttlMs);
  return bodyJson;
}

/**
 * Fetch raw content — files, README, SKILL.md, etc.
 * Different from ghFetch: returns text, not JSON.
 * NEVER wired to the TTL cache — file content is the product itself, and a
 * stale SKILL.md would poison the DNA library (see the cache block comment).
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

// ---------- Claude model registry ----------
// Source of truth: src/lib/claude-models.ts — premium = Mythos tier (Fable / Mythos) and
// Opus / Sonnet / Haiku 5.5+; real models below the threshold are blocked; pins above the
// known lineup are unverified until authority-confirmed.
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
 * Detects only qualifying (premium, registered) models. Use detectClaudeModels for the
 * full separation including blocked and unverified ones.
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
  /** true if only below-threshold models (4.x, Opus 5 / Sonnet 5 and older) were detected and no qualifying one — disqualified under the threshold rule */
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
    reasons.push(`🧠 Premium models: ${detection.qualifying.map((m) => m.label).join(", ")}`);
  }
  if (detection.fiction.length > 0 && detection.qualifying.length > 0) {
    reasons.push(`⚠️ Mixed: premium models + unverified pins (${detection.fiction.map((f) => f.label).join(", ")}) — the unverified ones earn no credit`);
  } else if (detection.fictionOnly) {
    // ⚠️ Only unverified model strings (above the known lineup) — no credit, mild distrust
    hints -= 3;
    reasons.push(`⚠️ Unverified model pins only (${detection.fiction.map((f) => f.label).join(", ")}) — no credit until Anthropic repos confirm the model`);
  } else if (detection.blockedOnly) {
    // ⛔ Only below-threshold models — zero model points + a block tag
    reasons.push(`⛔ Only ${detection.blocked.map((b) => b.label).join(", ")} detected — below the 5.5+ threshold`);
  }
  score += Math.min(hints, 18);

  const total = Math.max(0, Math.min(100, score));
  return { score: total, tier: tierOf(total).key, reasons, blockedOnly: detection.blockedOnly };
}
