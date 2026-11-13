// ============================================================
// DNA miner — extracting live Claude capabilities from elite repos
// Scans .claude/, CLAUDE.md, AGENTS.md and downloads the real content.
// This is the layer that turns a "successful repo" into portable genes for transplantation.
// ============================================================

import { ghFetch, ghFetchRaw, mapLimit, GhError } from "./github";

export interface MinedArtifact {
  path: string;
  kind: "skill" | "command" | "agent" | "claude-md" | "agents-md" | "mcp-config";
  name: string;
  description: string | null;
  content: string | null;
  rawUrl: string | null;
  size: number;
  truncated: boolean;
  /** Round 9: non-null when the content download itself FAILED (403 secondary
   *  rate limit, 429, 5xx, 20s timeout, DNS blip). A failed download is UNKNOWN,
   *  not a stub — the quality gate reports it separately and the strike ledger
   *  must not blame the repo. 404/422 (file genuinely gone) stays null: a clean
   *  miss, identical to the file never existing. Before: every transport error
   *  collapsed into content=null → "stub: 0B" → strike → a real elite repo got
   *  permanently banned off two bad minutes of network. */
  downloadError?: string | null;
}

export interface DnaPackage {
  repo: string;
  defaultBranch: string;
  artifacts: MinedArtifact[];
  scannedAt: string;
  /** true if the file tree was truncated (a giant repo) — the mine used to be silently partial; now it's reported */
  treeTruncated: boolean;
}

interface GhTree {
  truncated?: boolean;
  tree: { path: string; type: string; size?: number }[];
}

const MAX_FILE_BYTES = 12_000; // per-file content truncation — enough for the AI, saves quota

/**
 * Test/fixture paths are not capability files. Field evidence: Gen 6 mined
 * mcp_config_test.go (a Go test file) as "mcp-config" (gene #155) and
 * e2e/fixtures/.../SKILL.md (an e2e fixture) as "skill" (gene #108) — both entered
 * the library with false labeling. From now on: test/spec/fixture paths are rejected for mining.
 */
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec|specs|fixtures)(\/|$)|[._-]test\.[a-z]+$|\.spec\.[a-z]+$/i;

/** Classify a path into a DNA kind */
function classify(path: string): MinedArtifact["kind"] | null {
  const p = path.toLowerCase();
  if (TEST_PATH_RE.test(p)) return null;
  if (p === "claude.md") return "claude-md";
  if (p === "agents.md") return "agents-md";
  // Exactly SKILL.md (at any folder depth) — before, p.includes("skill") mistakenly
  // classified files like docs/my-skill.md as skills; now only the exact skill.md filename.
  if (/(^|\/)skill\.md$/.test(p)) return "skill";
  if (p.includes(".claude/commands/") && /\.md$/.test(p)) return "command";
  if (p.includes(".claude/agents/") && /\.md$/.test(p)) return "agent";
  if (p.includes(".mcp.json") || p.includes("mcp_config")) return "mcp-config";
  return null;
}

/** Extract the name from frontmatter or from the path */
function extractName(path: string, content: string | null, kind: MinedArtifact["kind"]): string {
  if (content) {
    // \r?\n — repos written on Windows with CRLF were never detected as frontmatter at all
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const nameLine = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
      if (nameLine) return nameLine.replace(/^["']|["']$/g, "");
    }
    const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (h1 && h1.length <= 80) return h1;
  }
  if (kind === "skill") {
    const parts = path.split("/");
    return parts[parts.length - 2] ?? path;
  }
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|json)$/i, "");
}

/** Extract the description from frontmatter */
function extractDescription(content: string | null): string | null {
  if (!content) return null;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const d = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (d) return d.slice(0, 300);
  }
  return null;
}

/**
 * Full DNA mining from a repo: tree scan → capability-file filtering → parallel content download.
 * defaultBranch is optional: when it comes from the discovery stage's GraphQL — it saves an
 * extra /repos call per repo (in a 6-repo harvest, that's 6 fewer calls).
 */
export async function mineDna(
  owner: string,
  repo: string,
  token: string | null,
  opts?: { defaultBranch?: string | null }
): Promise<DnaPackage> {
  const full = `${owner}/${repo}`;
  let branch = opts?.defaultBranch || "";
  if (!branch) {
    const meta = await ghFetch<{ default_branch: string }>(`/repos/${full}`, token);
    branch = meta.default_branch || "main";
  }

  const tree = await ghFetch<GhTree>(
    `/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token
  );

  const candidates = (tree.tree ?? [])
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size ?? 0, kind: classify(t.path) }))
    .filter((t): t is { path: string; size: number; kind: NonNullable<ReturnType<typeof classify>> } => !!t.kind)
    // Priority: skills and commands first, then CLAUDE.md; a reasonable size cap
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .slice(0, 12);

  // Throttled parallelism (6) — 12 downloads at once × 2 repos in parallel = 24 open
  // calls that could take down a GitHub secondary limit. A shared pool engine from github.ts.
  const results = await mapLimit(
    candidates,
    6,
    async (c): Promise<MinedArtifact> => {
      let content: string | null = null;
      let rawUrl: string | null = null;
      let truncated = false;
      let downloadError: string | null = null;
      try {
        content = await ghFetchRaw(
          `/repos/${full}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
          token
        );
        rawUrl = `https://github.com/${full}/blob/${branch}/${c.path.split("/").map(encodeURIComponent).join("/")}`; // path encoding — spaces/#/? in file names break the raw link
      } catch (e) {
        content = null;
        // 404/422 — the file is genuinely gone from the tree (a clean miss: the
        // tree snapshot raced a push). Anything else is a TRANSPORT failure and
        // is recorded as such so downstream never grades a network error as a
        // repo property ("stub") — the exact class round 8 closed in auditor.ts
        // grepRawFile; this was the other instance, silently striking elite repos.
        if (e instanceof GhError && (e.status === 404 || e.status === 422)) {
          // clean miss — stays a null-content artifact
        } else {
          downloadError = (e instanceof Error ? e.message : "download failed").slice(0, 160);
        }
      }
      if (content && content.length > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES) + "\n\n… [truncated for mining]";
        truncated = true;
      }
      return {
        path: c.path,
        kind: c.kind,
        name: extractName(c.path, content, c.kind),
        description: extractDescription(content),
        content,
        rawUrl,
        size: c.size,
        truncated,
        downloadError,
      };
    }
  );

  const artifacts = results;
  // (mapLimit throws only if a single call threw — but the inner catch guarantees that a failed
  // download returns content=null and doesn't take down the whole mine)

  return { repo: full, defaultBranch: branch, artifacts, scannedAt: new Date().toISOString(), treeTruncated: tree.truncated === true };
}

function rank(kind: MinedArtifact["kind"]): number {
  switch (kind) {
    case "skill":
      return 0;
    case "command":
      return 1;
    case "agent":
      return 2;
    case "claude-md":
      return 3;
    case "agents-md":
      return 4;
    case "mcp-config":
      return 5;
  }
}
