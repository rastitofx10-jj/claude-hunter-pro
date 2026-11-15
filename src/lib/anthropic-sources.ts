// ============================================================
// Official sources — Anthropic's own PUBLIC GitHub organizations.
//
// The star-weighted hunt finds what the community built. This module goes to the origin: the
// public repos Anthropic itself publishes (skills, plugins, cookbooks, Claude Code, Agent SDK,
// MCP) and mines them in FOLDER MODE — not just SKILL.md, but the whole capability folder:
//   skill            SKILL.md
//   skill-ref        references/*.md that sit next to a SKILL.md (the skill's deep docs)
//   plugin-manifest  .claude-plugin/plugin.json | marketplace.json (how a bundle is declared)
//   hook-config      hooks/hooks.json | .claude/settings.json (lifecycle + permission contracts)
//   command / agent / claude-md / agents-md / mcp-config as before
//
// Scope rules (deliberate):
//   * public repositories only, through the normal GitHub API with the user's own token;
//   * nothing is decrypted, deobfuscated or fetched from outside GitHub's public API;
//   * every gene keeps the repo's SPDX license in the library (provenance + license backfill).
//     Official repos mix licenses — check the license column before reusing a gene commercially.
//
// Server-side only.
// ============================================================

import { ghFetch, mapLimit } from "./github";
import { db } from "./db";
import { harvestRepo, type HarvestRepoReport, type HarvestResult } from "./harvester";

/** Anthropic-owned public GitHub organizations. Discovery is dynamic — no repo list is hardcoded. */
export const OFFICIAL_ORGS = ["anthropics", "modelcontextprotocol"] as const;

export interface OfficialRepo {
  fullName: string;
  org: string;
  description: string | null;
  stars: number;
  pushedAt: string | null;
  defaultBranch: string | null;
  license: string | null;
  topics: string[];
  score: number;
}

interface GhOrgRepo {
  full_name: string;
  name: string;
  description: string | null;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  size: number;
  stargazers_count: number;
  pushed_at: string | null;
  default_branch: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
}

/** Keyword weights over name + description + topics — where capability folders live. */
const HINTS: Array<[RegExp, number]> = [
  [/skills?/i, 60],
  [/plugins?|marketplace/i, 45],
  [/claude[-_ ]?code/i, 40],
  [/cookbook/i, 35],
  [/agent[-_ ]?sdk/i, 30],
  [/quickstart/i, 20],
  [/prompt/i, 20],
  [/\bmcp\b|servers?/i, 18],
  [/course|tutorial/i, 10],
  [/mythos|fable/i, 25],
];

/** Pure ranking of one org repo. `-Infinity` = never mine (archived, fork, disabled, empty). */
export function scoreOfficialRepo(r: GhOrgRepo, now: number = Date.now()): number {
  if (r.archived || r.disabled || r.fork || r.size <= 0) return -Infinity;
  const hay = `${r.name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`;
  let score = 0;
  for (const [re, w] of HINTS) if (re.test(hay)) score += w;
  score += Math.min(20, Math.log10(r.stargazers_count + 1) * 5);
  if (r.pushed_at) {
    const ageDays = (now - Date.parse(r.pushed_at)) / 86_400_000;
    if (ageDays <= 30) score += 10;
    else if (ageDays <= 180) score += 5;
  }
  return Number(score.toFixed(2));
}

export async function discoverOfficialRepos(
  token: string | null,
  orgs: readonly string[] = OFFICIAL_ORGS
): Promise<{ repos: OfficialRepo[]; failures: { org: string; error: string }[] }> {
  const failures: { org: string; error: string }[] = [];
  const all: OfficialRepo[] = [];
  const settled = await Promise.allSettled(
    orgs.map((org) =>
      ghFetch<GhOrgRepo[]>(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=public&sort=pushed&direction=desc`, token)
    )
  );
  settled.forEach((res, i) => {
    const org = orgs[i];
    if (res.status === "rejected") {
      failures.push({ org, error: res.reason instanceof Error ? res.reason.message : "discovery failed" });
      return;
    }
    for (const r of res.value) {
      const score = scoreOfficialRepo(r);
      if (!Number.isFinite(score)) continue;
      all.push({
        fullName: r.full_name,
        org,
        description: r.description,
        stars: r.stargazers_count,
        pushedAt: r.pushed_at,
        defaultBranch: r.default_branch,
        license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
        topics: r.topics ?? [],
        score,
      });
    }
  });
  all.sort((a, b) => b.score - a.score);
  return { repos: all, failures };
}

const MINED_KEY = "officialFolderMined"; // Setting row: { "owner/repo": ISO timestamp }
const REMINE_AFTER_MS = 7 * 86_400_000;

async function readMinedLog(): Promise<Record<string, string>> {
  try {
    const row = await db.setting.findUnique({ where: { key: MINED_KEY } });
    const j: unknown = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeMinedLog(log: Record<string, string>): Promise<void> {
  const value = JSON.stringify(log);
  await db.setting.upsert({ where: { key: MINED_KEY }, update: { value }, create: { key: MINED_KEY, value } });
}

/** Folder-mode harvest of the top-ranked official repos not mined in the last 7 days (unless `remine`). */
export async function harvestOfficial(
  token: string | null,
  opts: { maxRepos?: number; orgs?: readonly string[]; remine?: boolean } = {}
): Promise<HarvestResult & { orgs: string[]; orgFailures: { org: string; error: string }[]; kinds: Record<string, number> }> {
  const orgs = opts.orgs?.length ? opts.orgs : OFFICIAL_ORGS;
  const maxRepos = Math.max(1, Math.min(10, opts.maxRepos ?? 5));
  const { repos, failures } = await discoverOfficialRepos(token, orgs);

  const log = await readMinedLog();
  const now = Date.now();
  const due = repos.filter((r) => opts.remine || !log[r.fullName] || now - Date.parse(log[r.fullName]) > REMINE_AFTER_MS);
  const selected = due.slice(0, maxRepos);

  const reports: (HarvestRepoReport & { updatedCount: number })[] = [];
  const reposFailed: { repo: string; error: string }[] = [];
  const kinds: Record<string, number> = {};

  await mapLimit(selected, 2, async (r) => {
    try {
      const rep = await harvestRepo(
        r.fullName,
        token,
        { stars: r.stars, defaultBranch: r.defaultBranch, license: r.license },
        { folderMode: true, maxArtifacts: 40 }
      );
      reports.push(rep);
      for (const k of rep.kinds) kinds[k] = (kinds[k] ?? 0) + 1;
      log[r.fullName] = new Date().toISOString();
    } catch (e) {
      reposFailed.push({ repo: r.fullName, error: e instanceof Error ? e.message : "mining failed" });
    }
  });
  if (reports.length > 0) await writeMinedLog(log).catch(() => undefined);

  const [totalLibrary, fieldDna] = await Promise.all([
    db.dnaArtifact.count(),
    db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
  ]);
  return {
    candidatesFound: repos.length,
    reposMined: reports,
    artifactsAdded: reports.reduce((s, r) => s + r.newCount, 0),
    artifactsUpdated: reports.reduce((s, r) => s + r.updatedCount, 0),
    totalLibrary,
    fieldDna,
    skippedAlreadyMined: repos.length - due.length,
    qualityRejectedTotal: reports.reduce((s, r) => s + (r.qualityRejected?.length ?? 0), 0),
    queriesRun: orgs.map((o) => ({ q: `org:${o}`, count: repos.filter((r) => r.org === o).length })),
    queriesFailed: failures.map((f) => ({ q: `org:${f.org}`, error: f.error })),
    reposFailed,
    orgs: [...orgs],
    orgFailures: failures,
    kinds,
  };
}
