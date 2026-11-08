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

export async function ghFetch<T = unknown>(
  path: string,
  token?: string | null,
  accept?: string
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  // timeout נגד חיבורים תלויים — בעבר: sweep/audit נתקעו לנצח על TCP מת
  const res = await fetch(url, {
    headers: ghHeaders(token, accept),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      // keep default message
    }
    // Rate-limit detection happens HERE (source of truth) and is exposed as a
    // flag — the message shown to the user stays Hebrew, the machine-readable
    // signal never depends on message language again.
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection|מכסת/i.test(msg);
    if (isRateLimit) {
      msg = "מכסת GitHub API נגמרה (rate limit). הוסף Personal Access Token בהגדרות כדי להמשיך.";
    }
    if (res.status === 401) {
      msg = "הטוקן שסיפקת לא תקין או שפג תוקפו.";
    }
    throw new GhError(res.status, msg, isRateLimit);
  }
  return (await res.json()) as T;
}

/**
 * משיכת תוכן גלמי (raw) — קבצים, README, SKILL.md וכו'.
 * שונה מ-ghFetch: מחזיר טקסט ולא JSON.
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
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      // keep default message
    }
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection|מכסת/i.test(msg);
    if (isRateLimit) {
      msg = "מכסת GitHub API נגמרה (rate limit). הוסף Personal Access Token בהגדרות כדי להמשיך.";
    }
    if (res.status === 401) {
      msg = "הטוקן שסיפקת לא תקין או שפג תוקפו.";
    }
    throw new GhError(res.status, msg, isRateLimit);
  }
  return await res.text();
}

// ---------- input parsing ----------

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

// ---------- Claude model registry (סף מחמיר: 5.5+ בלבד) ----------
// מקור האמת: src/lib/claude-models.ts — משפחת 4.x חסומה לחלוטין.
export {
  MIN_QUALIFYING_VERSION,
  THRESHOLD_LABEL,
  THRESHOLD_RULE_TEXT,
  QUALIFYING_MODELS,
  classifyVersion,
  detectClaudeModels,
  isBlockedModelString,
  qualifyingModelOptions,
} from "./claude-models";
import { detectClaudeModels, type ClaudeModelDef } from "./claude-models";

// ---------- tier system ----------

export type TierKey = "elite" | "gold" | "silver" | "bronze" | "seed";

export const TIERS: { min: number; key: TierKey; label: string; emoji: string }[] = [
  { min: 80, key: "elite", label: "אליטה", emoji: "💎" },
  { min: 60, key: "gold", label: "זהב", emoji: "🥇" },
  { min: 40, key: "silver", label: "כסף", emoji: "🥈" },
  { min: 20, key: "bronze", label: "ארד", emoji: "🥉" },
  { min: 0, key: "seed", label: "נבט", emoji: "🌱" },
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
  if (!res.ok) {
    let msg = `GitHub API error ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string; errors?: { message?: string }[] };
      msg = j?.message ?? j?.errors?.[0]?.message ?? msg;
    } catch {
      // keep default
    }
    const isRateLimit =
      (res.status === 403 || res.status === 429) && /rate limit|secondary rate|abuse detection|מכסת/i.test(msg);
    if (isRateLimit) msg = "מכסת GitHub API נגמרה (rate limit). הוסף Personal Access Token בהגדרות כדי להמשיך.";
    if (res.status === 401) msg = "הטוקן שסיפקת לא תקין או שפג תוקפו.";
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
 * 8s/16s/32s and retry; any other error (private repo, bad token…) is thrown
 * immediately so we don't burn a minute on a query that can never succeed.
 */
export async function ghSearchWithBackoff<T>(path: string, token: string | null): Promise<T> {
  const delays = [8_000, 16_000, 32_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await ghFetch<T>(path, token);
    } catch (e) {
      lastErr = e;
      const rl = e instanceof GhError && (e.status === 403 || e.status === 429) && (e.rateLimited === true || /rate limit|secondary|מכסת/i.test(e.message));
      if (!rl || attempt === delays.length) throw e;
      await ghSleep(delays[attempt]);
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
 * זיהוי מודלים מזכים בלבד (≥5.5). מודלי 4.x ומטה לא מוחזרים מכאן —
 * השתמשו ב-detectClaudeModels לקבלת ההפרדה המלאה כולל חסומים.
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
  /** true אם זוהו רק מודלים חסומים (4.x ומטה) ואף מזכה — פסול לפי חוק הסף */
  blockedOnly: boolean;
} {
  const reasons: string[] = [];
  let score = 0;

  const traction = satScore(repo.stars, 20, 10000) + satScore(repo.forks, 6, 1000);
  score += traction;
  if (repo.stars > 0) reasons.push(`⭐ ${repo.stars.toLocaleString()} כוכבים`);

  if (repo.pushedAt) {
    const days = (Date.now() - new Date(repo.pushedAt).getTime()) / 86400000;
    if (days < 7) { score += 8; reasons.push("פעיל מאוד (7 ימים)"); }
    else if (days < 30) { score += 6; reasons.push("מעודכן החודש"); }
    else if (days < 90) { score += 4; reasons.push("מעודכן ברבעון האחרון"); }
    else if (days < 365) { score += 2; }
  }

  const hay = [repo.fullName, repo.description, (repo.topics ?? []).join(" ")].filter(Boolean).join(" ");
  let hints = 0;
  if (/\bclaude\b|claude[-_ ]?code/i.test(hay)) { hints += 6; reasons.push("מזוהה Claude"); }
  if (/anthropic/i.test(hay)) { hints += 5; reasons.push("מזוהה Anthropic"); }
  if (MCP_HINT.test(hay)) { hints += 3; reasons.push("אזכור MCP"); }
  if (AGENT_HINT.test(hay)) { hints += 3; reasons.push("אזכור סוכנים"); }
  const detection = detectClaudeModels(hay);
  if (detection.qualifying.length > 0) {
    hints += 6;
    reasons.push(`🧠 מודל 5.5+: ${detection.qualifying.map((m) => m.label).join(", ")}`);
  } else if (detection.blockedOnly) {
    // ⛔ רק מודלי 4.x ומטה — אפס נקודות מודל + תיוג חסימה
    reasons.push(`⛔ רק מודלי ${detection.blocked.map((b) => b.label).join(", ")} (מתחת לסף 5.5 — חסום)`);
  }
  score += Math.min(hints, 18);

  const total = Math.max(0, Math.min(100, score));
  return { score: total, tier: tierOf(total).key, reasons, blockedOnly: detection.blockedOnly };
}
