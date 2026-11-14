import { NextRequest, NextResponse } from "next/server";
import {
  GhError,
  ghFetch,
  ghFetchRaw,
  ghSearchWithBackoff,
  detectClaudeModels,
  detectModelFieldValue,
  QUALIFYING_MODELS,
  tierOf,
  satScore,
} from "@/lib/github";
import type { AnalyzeResponse, EvidenceItem, ModelHit, RepoCore, ClaudeFileInfo } from "@/lib/hunter-types";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";
import { scanAndRecord } from "@/lib/emerging-models";

export const dynamic = "force-dynamic";

// ---------- GitHub raw shapes ----------
interface GhRepoMeta {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  open_issues_count?: number;
  language: string | null;
  topics?: string[];
  pushed_at: string;
  created_at: string;
  size: number;
  archived: boolean;
  license?: { spdx_id?: string } | null;
  default_branch: string;
  owner: { login: string; type?: string; avatar_url?: string };
}

interface GhTree {
  truncated?: boolean;
  tree: { path: string; type: string }[];
}

interface GhContrib { login?: string; contributions: number }

export async function GET(req: NextRequest) {
  const token = await resolveToken(req);
  const owner = req.nextUrl.searchParams.get("owner")?.trim();
  const repo = req.nextUrl.searchParams.get("repo")?.trim();
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: "Valid owner and repo are required" }, { status: 400 });
  }
  const full = `${owner}/${repo}`;
  const warnings: string[] = [];

  try {
    const meta = await ghFetch<GhRepoMeta>(`/repos/${full}`, token);
    // The token from the header was validated against GitHub — saved for server use
    await captureTokenFrom(req);

    const [languagesR, contribR, readmeR, treeR] = await Promise.allSettled([
      ghFetch<Record<string, number>>(`/repos/${full}/languages`, token),
      ghFetch<GhContrib[]>(`/repos/${full}/contributors?per_page=100&anon=1`, token),
      ghFetchRaw(`/repos/${full}/readme`, token),
      ghFetch<GhTree>(`/repos/${full}/git/trees/${encodeURIComponent(meta.default_branch)}?recursive=1`, token),
    ]);

    const languages = languagesR.status === "fulfilled" ? languagesR.value : {};
    const contributors =
      contribR.status === "fulfilled" && Array.isArray(contribR.value) ? contribR.value.length : 0;
    const readme = readmeR.status === "fulfilled" && typeof readmeR.value === "string" ? readmeR.value.slice(0, 20000) : "";
    const treeOk = treeR.status === "fulfilled";
    const tree = treeOk ? treeR.value.tree ?? [] : [];
    if (!treeOk) {
      warnings.push("Failed to read the file tree (rate limit/huge repo) — falling back to standard path scanning");
    } else if (treeR.value.truncated) {
      warnings.push("File tree is partial (very large repo) — some files may be missing from the scan");
    }
    const paths = tree.map((t) => t.path);

    // ---------- classify claude-related files from tree ----------
    const claudeFiles: ClaudeFileInfo[] = [];
    const commands: string[] = [];
    const agents: string[] = [];
    const pushClaudeFile = (p: string, kind: string) => {
      if (!claudeFiles.some((f) => f.path === p)) {
        claudeFiles.push({
          path: p,
          kind,
          // Path encoding — previously inserted raw; spaces/#/? in file names broke the link
          // (same fix already present in dna-miner.ts, now applied to analysis too)
          url: `https://github.com/${full}/blob/${meta.default_branch}/${p.split("/").map(encodeURIComponent).join("/")}`,
        });
      }
    };

    for (const p of paths) {
      const lp = p.toLowerCase();
      let kind: string | null = null;
      if (/^claude\.md$/.test(lp) || /(^|\/)claude\.md$/.test(lp)) kind = "claude-md";
      else if (/^\.claude\/settings\.json$/.test(lp)) kind = "settings";
      else if (/^\.claude\/settings\.local\.json$/.test(lp)) kind = "settings-local";
      else if (/^\.claude\/commands\/.+\.md$/.test(lp)) { kind = "command"; commands.push(p.split("/").pop()!.replace(/\.md$/, "")); }
      else if (/^\.claude\/agents\/.+\.md$/.test(lp)) { kind = "agent"; agents.push(p.split("/").pop()!.replace(/\.md$/, "")); }
      else if (/^\.claude\/hooks\//.test(lp)) kind = "hook";
      else if (/^\.claude\/output-styles\//.test(lp)) kind = "output-style";
      else if (/^\.claude\//.test(lp)) kind = "claude-dir";
      else if (/^\.mcp\.json$/.test(lp)) kind = "mcp";
      if (kind) pushClaudeFile(p, kind);
    }

    // ---------- sequential content fetcher (avoids secondary rate limits) ----------
    // ghFetchRaw instead of ghFetch — ghFetch runs res.json() on raw files:
    // markdown threw SyntaxError → null, and JSON became "[object Object]".
    // That killed all content-based model detection (CLAUDE.md/settings/package.json) entirely.
    const fetchRaw = async (path: string): Promise<string | null> => {
      try {
        const raw = await ghFetchRaw(
          `/repos/${full}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(meta.default_branch)}`,
          token
        );
        return raw.slice(0, 12000);
      } catch {
        return null;
      }
    };

    // candidates: tree match first, standard guesses as fallback
    const treeFind = (re: RegExp) => paths.find((p) => re.test(p)) ?? null;
    const wanted: { key: string; path: string | null; kind?: string }[] = [
      { key: "claudeMd", path: treeFind(/^claude\.md$/i) ?? treeFind(/claude\.md$/i), kind: "claude-md" },
      { key: "settings", path: treeFind(/^\.claude\/settings\.json$/i), kind: "settings" },
      { key: "mcp", path: treeFind(/^\.mcp\.json$/i), kind: "mcp" },
      { key: "pkg", path: treeFind(/^package\.json$/i) },
      { key: "pyproject", path: treeFind(/^pyproject\.toml$/i) },
      { key: "requirements", path: treeFind(/^requirements\.txt$/i) },
      { key: "envExample", path: treeFind(/^\.env\.example$/i) },
    ];

    // fallback guesses when tree missed the file (tree failed or truncated)
    const guessPlan: { key: string; guesses: string[]; kind?: string }[] = [
      { key: "claudeMd", guesses: ["CLAUDE.md", "claude.md", "CLAUDE.local.md"], kind: "claude-md" },
      { key: "settings", guesses: [".claude/settings.json"], kind: "settings" },
      { key: "mcp", guesses: [".mcp.json"], kind: "mcp" },
      { key: "pkg", guesses: ["package.json"] },
      { key: "pyproject", guesses: ["pyproject.toml"] },
      { key: "requirements", guesses: ["requirements.txt"] },
      { key: "envExample", guesses: [".env.example"] },
    ];
    // (Previously: w.path was filled from guesses[0] only — the loop below applies all the guesses)
    const contents: Record<string, string> = {};
    for (const w of wanted) {
      if (w.path) {
        const raw = await fetchRaw(w.path);
        if (raw != null) {
          contents[w.key] = raw;
          if (w.kind) pushClaudeFile(w.path, w.kind);
        }
        continue;
      }
      // The tree missed the file — previously only the first guess (guesses[0]) was tried;
      // CLAUDE.local.md and claude.md were never tried despite being defined in the plan.
      const plan = guessPlan.find((g) => g.key === w.key);
      if (!plan) continue;
      for (const g of plan.guesses) {
        const raw = await fetchRaw(g);
        if (raw != null) {
          contents[w.key] = raw;
          if (plan.kind) pushClaudeFile(g, plan.kind);
          break;
        }
      }
    }

    // if tree failed, try listing .claude/commands + .claude/agents directories
    if (!treeOk) {
      for (const dir of ["commands", "agents"] as const) {
        try {
          const listing = await ghFetch<{ name: string; path: string; type: string }[]>(
            `/repos/${full}/contents/.claude/${dir}?ref=${encodeURIComponent(meta.default_branch)}`,
            token
          );
          if (Array.isArray(listing)) {
            for (const it of listing) {
              if (it.type !== "file") continue;
              if (dir === "commands") {
                commands.push(it.name.replace(/\.md$/i, ""));
                pushClaudeFile(it.path, "command");
              } else {
                agents.push(it.name.replace(/\.md$/i, ""));
                pushClaudeFile(it.path, "agent");
              }
            }
          }
        } catch {
          // directory doesn't exist — fine
        }
      }
    }

    // ---------- dependency detection ----------
    const evidence: EvidenceItem[] = [];
    const depsFound: string[] = [];
    if (contents.pkg) {
      try {
        const pkg = JSON.parse(contents.pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        if (all.includes("@anthropic-ai/sdk")) { depsFound.push("@anthropic-ai/sdk"); evidence.push({ kind: "dep", label: "Official Anthropic SDK (@anthropic-ai/sdk)", weight: 12 }); }
        if (all.includes("@anthropic-ai/claude-code")) { depsFound.push("@anthropic-ai/claude-code"); evidence.push({ kind: "dep", label: "Claude Code dependency", weight: 15 }); }
        if (all.includes("@anthropic-ai/claude-agent-sdk")) { depsFound.push("@anthropic-ai/claude-agent-sdk"); evidence.push({ kind: "dep", label: "Claude Agent SDK", weight: 15 }); }
        if (all.includes("@ai-sdk/anthropic")) { depsFound.push("@ai-sdk/anthropic"); evidence.push({ kind: "dep", label: "Vercel AI SDK with Anthropic provider", weight: 10 }); }
        if (all.includes("@langchain/anthropic")) { depsFound.push("@langchain/anthropic"); evidence.push({ kind: "dep", label: "LangChain Anthropic", weight: 10 }); }
      } catch { /* invalid package.json */ }
    }
    const pyHay = `${contents.pyproject ?? ""}\n${contents.requirements ?? ""}`.toLowerCase();
    if (/\banthropic\b/.test(pyHay) && !/langchain-anthropic/.test(pyHay)) {
      depsFound.push("anthropic (python)");
      evidence.push({ kind: "dep", label: "anthropic Python library", weight: 12 });
    }
    if (pyHay.includes("langchain-anthropic")) { depsFound.push("langchain-anthropic"); evidence.push({ kind: "dep", label: "LangChain Anthropic (Python)", weight: 10 }); }
    if (pyHay.includes("claude-code-sdk") || pyHay.includes("claude_agent_sdk")) { depsFound.push("claude-code-sdk"); evidence.push({ kind: "dep", label: "Claude Code SDK (Python)", weight: 15 }); }

    // ---------- structure evidence ----------
    if (contents.claudeMd) evidence.push({ kind: "claude-md", label: "CLAUDE.md file — serial development instructions with Claude", weight: 8, url: claudeFiles.find((f) => f.kind === "claude-md")?.url });
    if (contents.settings) evidence.push({ kind: "settings", label: ".claude/settings.json — Claude Code settings", weight: 4 });
    if (commands.length > 0) evidence.push({ kind: "commands", label: `${commands.length} custom commands in .claude/commands`, weight: Math.min(10, commands.length * 2) });
    if (agents.length > 0) evidence.push({ kind: "agents", label: `${agents.length} subagents in .claude/agents`, weight: 5 });

    let mcpServers: string[] = [];
    if (contents.mcp) {
      try {
        const mcp = JSON.parse(contents.mcp) as { mcpServers?: Record<string, unknown> };
        mcpServers = Object.keys(mcp.mcpServers ?? {});
        if (mcpServers.length > 0) evidence.push({ kind: "mcp", label: `MCP servers: ${mcpServers.join(", ")}`, weight: 6 });
      } catch { /* invalid */ }
    }
    if (contents.envExample && /ANTHROPIC_API_KEY\s*=/.test(contents.envExample)) {
      // Tightened: previously /anthropic|claude/i was enough — a CLAUDE_CODE_PORT= line earned 12 points for "paid API connection"
      evidence.push({ kind: "env", label: "ANTHROPIC_API_KEY in .env.example — paid API connection", weight: 12 });
    }

    // ---------- settings.json model scan ----------
    let settingsModelText = "";
    if (contents.settings) {
      try {
        const st = JSON.parse(contents.settings) as { model?: string };
        if (typeof st.model === "string") settingsModelText = st.model;
      } catch { /* invalid */ }
    }

    // ---------- README scans ----------
    const priceMentions = [...readme.matchAll(/(?:\$|USD\s?|~)\s?\d[\d,.]*\s?[km]?\b/gi)].map((m) => m[0]).slice(0, 5);
    const tokenMentions = [...readme.matchAll(/\b\d[\d,.]*\s?[km]?\s?(?:tokens|token)\b/gi)].map((m) => m[0]).slice(0, 5);
    const claudeCodeMentions = (readme.match(/claude[ -]?code/gi) ?? []).length;
    const builtWithClaude = /built with claude|powered by claude|developed with claude|created with claude|written with claude/i.test(readme);
    if (builtWithClaude) evidence.push({ kind: "readme", label: "README declares: built with Claude", weight: 6 });
    if (priceMentions.length > 0) evidence.push({ kind: "cost", label: `Cost mentions in README: ${priceMentions.slice(0, 3).join(", ")}`, weight: 5 });

    // ---------- in-repo code search for model strings ----------
    const models = new Map<string, ModelHit>();
    const addModel = (
      id: string,
      label: string,
      weight: number,
      source: string,
      hits?: number,
      qualifying = true,
      version?: number
    ) => {
      const cur = models.get(id);
      if (cur) {
        if (!cur.sources.includes(source)) cur.sources.push(source);
        if (hits != null) cur.hits = Math.max(cur.hits ?? 0, hits);
      } else {
        models.set(id, { id, label, weight, sources: [source], hits, qualifying, version });
      }
    };

    if (token) {
      // Only registered premium models are scanned and counted (Mythos tier and
      // 5.5+); below-threshold and unverified strings are never searched.
      // Longest-first order + skipping subsumed identifiers: a searched identifier is a substring —
      // a shorter id also catches repos with only the longer variant, falsely reporting the family.
      const kws: [string, string, number][] = QUALIFYING_MODELS.map((m) => [
        m.searchStrings[0],
        m.label,
        m.weight,
      ] as [string, string, number]).sort((a, b) => b[0].length - a[0].length);
      const foundLong: string[] = []; // identifiers actually found — a shorter identifier that is their substring will not be searched
      for (let i = 0; i < kws.length; i++) {
        const [kw, label, weight] = kws[i];
        const lowerKw = kw.toLowerCase();
        if (foundLong.some((f) => f.toLowerCase().includes(lowerKw))) continue; // already represented by a longer identifier
        try {
          // Built-in backoff instead of manual 403 handling + a fixed 1.5s even after the last query
          const r = await ghSearchWithBackoff<{ total_count: number }>(
            `/search/code?q=${encodeURIComponent(`repo:${full} "${kw}"`)}&per_page=1`,
            token
          );
          if ((r.total_count ?? 0) > 0) {
            addModel(kw, label, weight, "code-search", r.total_count, true);
            foundLong.push(kw);
          }
        } catch (e) {
          if (e instanceof GhError && [403, 429].includes(e.status)) {
            warnings.push("Code search paused — search rate limit temporarily exhausted");
            break;
          }
          // 422 = qualifier problem etc — continue silently
        }
        if (i < kws.length - 1) await new Promise((res) => setTimeout(res, 1500));
      }
    } else {
      warnings.push("Without a token, no in-repo code search is performed (metadata file scanning only)");
    }

    // Text-based detection: settings / CLAUDE.md / README — full separation between
    // qualifying (premium registered models) vs blocked (real but below 5.5+) vs
    // unverified (above the known lineup — shown for transparency, zero credit, flagged).
    // The settings model field is a CONTROLLED context — its value IS a model identifier,
    // so a bare family pin ("opus" → Opus 5.5, the family frontier) is decisive here
    // even without prose context.
    if (settingsModelText) {
      const pinned = detectModelFieldValue(settingsModelText);
      if (pinned) addModel(pinned.id, pinned.label, pinned.weight, "settings", undefined, true, pinned.version);
    }
    const sourceOf = (id: string): string => {
      const smt = settingsModelText.toLowerCase();
      // settings values legitimately lack the claude- prefix ("opus-5-5") — compare both forms
      if (smt.includes(id) || smt.includes(id.replace(/^claude-/, ""))) return "settings";
      const cm = (contents.claudeMd ?? "").toLowerCase();
      if (cm.includes(id) || cm.includes(id.replace(/^claude-/, ""))) return "claude-md";
      return "readme";
    };
    const textDetection = detectClaudeModels(
      `${settingsModelText} ${contents.claudeMd ?? ""} ${readme.slice(0, 4000)}`
    );
    // Frontier radar — the same text the detector just scanned also feeds the
    // emerging-model ledger: an analysis of a repo pinning a version above the
    // registry frontier (a future release, a brand-new family) is day-one evidence.
    // Confirmation stays authority-gated (org:anthropics) — never blocks the analysis.
    try {
      await scanAndRecord(
        `${settingsModelText} ${contents.claudeMd ?? ""} ${readme}`,
        full,
        "analyze",
      );
    } catch { /* radar must never stall the analysis */ }
    for (const m of textDetection.qualifying) {
      addModel(m.id, m.label, m.weight, sourceOf(m.id), undefined, true, m.version);
    }
    // Blocked (below threshold) + UNVERIFIED (above the known lineup): transparency only —
    // weight 0, not counted in the score; unverified pins carry an explicit warning label.
    for (const b of [...textDetection.blocked, ...textDetection.fiction]) {
      addModel(b.id, b.label, 0, sourceOf(b.id), undefined, false, b.version);
    }

    const modelList = Array.from(models.values()).sort((a, b) => b.weight - a.weight);
    const qualifyingList = modelList.filter((m) => m.qualifying);
    const blockedList = modelList.filter((m) => !m.qualifying);

    // ---------- scoring ----------
    // Model score: qualifying (premium) models only. No qualifying model → zero model points.
    const modelScore = qualifyingList.length > 0 ? Math.min(45, qualifyingList[0].weight) : 0;
    // Only genuine payment evidence: SDK dependencies (dep), API key (env), MCP servers, cost mentions.
    // Previously: all evidence — including structural (CLAUDE.md/commands/agents/README) — counted toward the
    // "payment & API evidence" column, and a purely structural repo reached 30/30 with no paid connection at all.
    const paidKinds = new Set(["dep", "env", "mcp", "cost"]);
    const paidScore = Math.min(30, evidence.filter((e) => paidKinds.has(e.kind)).reduce((s, e) => s + e.weight, 0));
    const tractionScore = Math.min(
      25,
      satScore(meta.stargazers_count, 15, 10000) + satScore(meta.forks_count, 5, 1000) + satScore(contributors, 5, 30)
    );
    const usageScore = Math.min(15, priceMentions.length * 3 + tokenMentions.length * 2 + Math.min(claudeCodeMentions, 4) + (builtWithClaude ? 3 : 0));
    // Threshold rule — only a repo proving a premium 5.5+/Mythos-tier model can reach the
    // premium tiers (gold/elite): without a qualifying model the score is capped at 35.
    const meetsModelThreshold = qualifyingList.length > 0;
    const rawTotal = Math.max(0, modelScore + paidScore + tractionScore + usageScore);
    const total = Math.min(100, meetsModelThreshold ? rawTotal : Math.min(rawTotal, 35));
    const tier = tierOf(total);

    // ---------- languages ----------
    const langTotal = Object.values(languages).reduce((s, v) => s + v, 0) || 1;
    const langList = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, bytes]) => ({ name, pct: Math.round((bytes / langTotal) * 1000) / 10 }));

    // ---------- insights (what can we learn / take) ----------
    const insights: string[] = [];
    const fictionList = modelList.filter((m) => m.label.includes("(unverified)"));
    if (!meetsModelThreshold) {
      // Strict verdict: no qualifying model → not a premium project per the criterion
      insights.push(
        fictionList.length > 0
          ? `⛔ Unverified model pins only (${fictionList.map((b) => b.label).join(", ")}) — not in the known lineup, zero credit until Anthropic repos confirm them`
          : blockedList.length > 0
          ? `⛔ Does not meet the threshold: only below-threshold models detected (${blockedList.map((b) => b.label).join(", ")}) — the criterion requires Fable / Mythos or Opus / Sonnet / Haiku 5.5+`
          : `⛔ Does not meet the threshold: no premium Claude model detected`
      );
      // Transparency: what exactly cut the score
      insights.push(`Raw score ${rawTotal} cut to ${total} — without proof of a premium model, premium tiers are not granted`);
    } else {
      insights.push(`✅ Meets the model threshold (premium 5.5+): ${qualifyingList.map((m) => m.label).join(", ")}${blockedList.length > 0 ? ` — plus non-counted mentions of ${blockedList.map((b) => b.label).join(", ")}` : ""}${fictionList.length > 0 ? ` — ⚠️ plus unverified pins (${fictionList.map((f) => f.label).join(", ")}) earning no credit` : ""}`);
    }
    if (contents.claudeMd) insights.push("Has a CLAUDE.md — worth studying its instruction structure, boundaries, and defined workflows and adapting them to our interface");
    if (commands.length > 0) insights.push(`${commands.length} custom commands (${commands.slice(0, 5).join(", ")}) — the ideas can be adopted for similar commands`);
    if (agents.length > 0) insights.push(`${agents.length} subagents defined (${agents.slice(0, 5).join(", ")}) — a proven multi-agent architecture worth imitating`);
    if (mcpServers.length > 0) insights.push(`Active MCP servers (${mcpServers.join(", ")}) — tool integrations we could hook up as well`);
    if (qualifyingList.some((m) => m.weight >= 40)) insights.push("Uses a top-tier model (Mythos tier / Opus 5.5) — the project proves its tasks justify the strongest models; worth examining which workflows exploit this");
    if (depsFound.length > 0) insights.push(`SDK stack: ${depsFound.join(", ")} — a good starting point for understanding the integration`);
    if (priceMentions.length > 0 || tokenMentions.length > 0) insights.push("Cost/token mentions in the README — an indication of real paid usage at significant scale");
    if (contributors > 5) {
      // The API caps at 100 — previously a repo with 500 contributors was reported as "100 contributors"
      insights.push(
        contributors >= 100
          ? "100+ contributors (API cap) — a living project with a community, not a personal experiment"
          : `${contributors} contributors — a living project with a community, not a personal experiment`
      );
    }

    const repoCore: RepoCore = {
      id: meta.id,
      fullName: meta.full_name,
      owner: { login: meta.owner.login, type: meta.owner.type, avatar_url: meta.owner.avatar_url },
      htmlUrl: meta.html_url,
      description: meta.description,
      stars: meta.stargazers_count,
      forks: meta.forks_count,
      watchers: meta.subscribers_count,
      openIssues: meta.open_issues_count,
      language: meta.language,
      topics: meta.topics ?? [],
      pushedAt: meta.pushed_at,
      createdAt: meta.created_at,
      size: meta.size,
      archived: meta.archived,
      license: meta.license?.spdx_id ?? null,
      defaultBranch: meta.default_branch,
    };

    const resp: AnalyzeResponse = {
      repo: repoCore,
      score: { total, tier: tier.key, modelScore, paidScore, tractionScore, usageScore, meetsModelThreshold },
      models: modelList,
      evidence,
      claudeFiles,
      commands: commands.slice(0, 12),
      agents: agents.slice(0, 12),
      mcpServers,
      languages: langList,
      contributors,
      readmeExcerpt: readme ? readme.slice(0, 2500) : undefined,
      mentions: { prices: priceMentions, tokens: tokenMentions, claudeCode: claudeCodeMentions, builtWithClaude },
      insights,
      warnings,
      analyzedAt: new Date().toISOString(),
    };
    return NextResponse.json(resp);
  } catch (e) {
    if (e instanceof GhError) {
      const friendly = e.status === 404 ? `Repository ${full} not found on GitHub (404) — check the address` : e.message;
      return NextResponse.json({ error: friendly }, { status: e.status });
    }
    console.error("analyze failed", e);
    return NextResponse.json({ error: "Analysis failed. Try again." }, { status: 500 });
  }
}
