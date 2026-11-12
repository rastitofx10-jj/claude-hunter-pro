// ============================================================
// Frontier queries — the anti-saturation dimension.
//
// Field evidence (gens 6→9): growth per run collapsed +57 → +9 → +3 → +1
// because every generation re-probed the same corners: model strings,
// 4 capability phrases, 7 repo searches. The candidates that dimension
// can find were already found — the watchlist froze at 6 repos.
//
// The frontier probes coordinates the arsenal never touched:
// - contract files (settings.json, hooks, subagents, slash commands)
// - the Agent SDK (the newest ecosystem surface)
// - MCP server configs
// - young repos (created:< filter — invisible to star-weighted ranking)
// - fresh topics (claude-skills, agent-skills) and awesome lists
//
// The pools are LARGER than a single hunt's budget: each run takes a
// rotating slice (deterministic, seeded by generation/day), so coverage
// compounds across runs instead of repeating.
// ============================================================

export interface FrontierQuery {
  q: string;
  kind: "code" | "repo";
  why: string;
}

/** Code-search frontier — contract files & SDK surface. */
export const FRONTIER_CODE_POOL: FrontierQuery[] = [
  { q: '"allowed-tools" filename:SKILL.md', kind: "code", why: "real Claude skill frontmatter — the strictest skill marker" },
  { q: "claude-agent-sdk", kind: "code", why: "Agent SDK imports — the newest ecosystem surface" },
  { q: "from claude_agent_sdk import", kind: "code", why: "Agent SDK (python) usage" },
  { q: '"mcpServers" claude', kind: "code", why: "MCP server configs wired to Claude" },
  { q: "PreToolUse .claude", kind: "code", why: "hooks contracts (Claude Code hook events)" },
  { q: "path:.claude/commands", kind: "code", why: "slash command definitions" },
  { q: "path:.claude/agents", kind: "code", why: "subagent definitions" },
  { q: "filename:CLAUDE.md guidelines", kind: "code", why: "project contract files" },
  { q: "filename:settings.json path:.claude", kind: "code", why: "permissions/settings contracts" },
];

/** Repo-search frontier — young repos, fresh topics, curated lists. */
export const FRONTIER_REPO_POOL: FrontierQuery[] = [
  { q: "claude skills created:{fresh}", kind: "repo", why: "skills repos younger than 60d — invisible to star ranking" },
  { q: "claude agent created:{fresh} stars:>=1", kind: "repo", why: "young agent repos with minimal traction" },
  { q: "topic:claude-skills stars:>=1", kind: "repo", why: "the claude-skills topic (unprobed)" },
  { q: "topic:agent-skills stars:>=1", kind: "repo", why: "the agent-skills topic (unprobed)" },
  { q: "awesome claude stars:>=10", kind: "repo", why: "curated awesome lists — ecosystem goldmines" },
];

/** Model frontier — new model releases create a content wave before the
 *  star-weighted radar notices. TRUTH-FIX (2026-11-12): this pool used to
 *  hunt fictional model strings (fable 5.2 & co) and burned the code-search
 *  quota on hallucinations. It now hunts the REAL frontier: repos pinning
 *  the strongest models that actually exist (Opus 4.5, Sonnet 4.5). When
 *  the authority-gated radar confirms a real future release, its wave
 *  queries are auto-generated (emerging-models.ts) — no manual edits. */
export const FRONTIER_MODEL_POOL: FrontierQuery[] = [
  { q: '"claude-opus-4-5"', kind: "code", why: "opus 4.5 model-string pin — the strongest real model, day-one adopters" },
  { q: '"claude-opus-4-5" filename:SKILL.md', kind: "code", why: "skills written for the real flagship" },
  { q: '"opus 4.5" filename:CLAUDE.md', kind: "code", why: "project contracts pinning opus 4.5" },
  { q: '"claude-sonnet-4-5" "claude-opus-4-5"', kind: "code", why: "model routers comparing the real frontier pair" },
  { q: '"claude-opus-4-5-20251101"', kind: "code", why: "dated snapshot pins — API-level integrations" },
  { q: '"claude-opus-4-5" eval', kind: "code", why: "eval harnesses measuring the real flagship" },
  { q: '"claude-haiku-4-5" filename:CLAUDE.md', kind: "code", why: "cheap-tier contracts wired to the real haiku frontier" },
];

/** Deterministic rotation: `count` items from `pool`, starting at `seed % pool.length`.
 *  Wraps around — a pool larger than the slice guarantees cross-run novelty. */
export function rotateSlice<T>(pool: T[], seed: number, count: number): T[] {
  if (pool.length === 0 || count <= 0) return [];
  const out: T[] = [];
  const offset = ((seed % pool.length) + pool.length) % pool.length;
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    out.push(pool[(offset + i) % pool.length]);
  }
  return out;
}

/** `{fresh}` placeholder → an ISO date N days back (repo-search created: filter). */
export function hydrateFresh(q: string, days = 60): string {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return q.replace(/\{fresh\}/g, since);
}

/** Day-of-year seed for harvest rotation — flips once a day, deterministic within it. */
export function daySeed(): number {
  return Math.floor(Date.now() / 86400000);
}
