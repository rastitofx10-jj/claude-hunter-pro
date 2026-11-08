import { NextRequest, NextResponse } from "next/server";
import {
  GhError,
  ghFetch,
  ghFetchRaw,
  detectClaudeModels,
  QUALIFYING_MODELS,
  tierOf,
  satScore,
} from "@/lib/github";
import type { AnalyzeResponse, EvidenceItem, ModelHit, RepoCore, ClaudeFileInfo } from "@/lib/hunter-types";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

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
    return NextResponse.json({ error: "נדרש owner ו-repo תקינים" }, { status: 400 });
  }
  const full = `${owner}/${repo}`;
  const warnings: string[] = [];

  try {
    const meta = await ghFetch<GhRepoMeta>(`/repos/${full}`, token);
    // הטוקן מהכותרת עבר אימות מול GitHub — נשמר לשימוש השרת
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
      warnings.push("קריאת עץ הקבצים נכשלה (מכסה/מאגר ענק) — מופעלת סריקת נתיבים סטנדרטיים");
    } else if (treeR.value.truncated) {
      warnings.push("עץ הקבצים חלקי (מאגר ענק מאוד) — ייתכן שחסרים קבצים מהסריקה");
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
          // קידוד נתיב — בעבר הוכנס גולמי; רווחים/#/? בשמות קבצים שברו את הקישור
          // (אותו תיקון שכבר קיים ב-dna-miner.ts, כאן הוחל גם על הניתוח)
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
    // ghFetchRaw ולא ghFetch — ghFetch מפעיל res.json() על קבצים גלמיים:
    // markdown זרק SyntaxError → null, ו-JSON התרגם ל-"[object Object]".
    // זה הרג את כל זיהוי המודלים-מתוכן (CLAUDE.md/settings/package.json) לחלוטין.
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
    for (const w of wanted) {
      if (!w.path) {
        const plan = guessPlan.find((g) => g.key === w.key);
        if (plan) w.path = plan.guesses[0];
      }
    }

    const contents: Record<string, string> = {};
    for (const w of wanted) {
      if (!w.path) continue;
      const raw = await fetchRaw(w.path);
      if (raw != null) {
        contents[w.key] = raw;
        if (w.kind) pushClaudeFile(w.path, w.kind);
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
        if (all.includes("@anthropic-ai/sdk")) { depsFound.push("@anthropic-ai/sdk"); evidence.push({ kind: "dep", label: "SDK רשמי של Anthropic (@anthropic-ai/sdk)", weight: 12 }); }
        if (all.includes("@anthropic-ai/claude-code")) { depsFound.push("@anthropic-ai/claude-code"); evidence.push({ kind: "dep", label: "תלות ב-Claude Code", weight: 15 }); }
        if (all.includes("@anthropic-ai/claude-agent-sdk")) { depsFound.push("@anthropic-ai/claude-agent-sdk"); evidence.push({ kind: "dep", label: "Claude Agent SDK", weight: 15 }); }
        if (all.includes("@ai-sdk/anthropic")) { depsFound.push("@ai-sdk/anthropic"); evidence.push({ kind: "dep", label: "Vercel AI SDK עם פרוביידר Anthropic", weight: 10 }); }
        if (all.includes("@langchain/anthropic")) { depsFound.push("@langchain/anthropic"); evidence.push({ kind: "dep", label: "LangChain Anthropic", weight: 10 }); }
      } catch { /* invalid package.json */ }
    }
    const pyHay = `${contents.pyproject ?? ""}\n${contents.requirements ?? ""}`.toLowerCase();
    if (/\banthropic\b/.test(pyHay) && !/langchain-anthropic/.test(pyHay)) {
      depsFound.push("anthropic (python)");
      evidence.push({ kind: "dep", label: "ספריית anthropic בפייתון", weight: 12 });
    }
    if (pyHay.includes("langchain-anthropic")) { depsFound.push("langchain-anthropic"); evidence.push({ kind: "dep", label: "LangChain Anthropic (פייתון)", weight: 10 }); }
    if (pyHay.includes("claude-code-sdk") || pyHay.includes("claude_agent_sdk")) { depsFound.push("claude-code-sdk"); evidence.push({ kind: "dep", label: "Claude Code SDK (פייתון)", weight: 15 }); }

    // ---------- structure evidence ----------
    if (contents.claudeMd) evidence.push({ kind: "claude-md", label: "קובץ CLAUDE.md — הוראות פיתוח סריאלי עם Claude", weight: 8, url: claudeFiles.find((f) => f.kind === "claude-md")?.url });
    if (contents.settings) evidence.push({ kind: "settings", label: ".claude/settings.json — הגדרות Claude Code", weight: 4 });
    if (commands.length > 0) evidence.push({ kind: "commands", label: `${commands.length} פקודות מותאמות ב-.claude/commands`, weight: Math.min(10, commands.length * 2) });
    if (agents.length > 0) evidence.push({ kind: "agents", label: `${agents.length} סוכני משנה ב-.claude/agents`, weight: 5 });

    let mcpServers: string[] = [];
    if (contents.mcp) {
      try {
        const mcp = JSON.parse(contents.mcp) as { mcpServers?: Record<string, unknown> };
        mcpServers = Object.keys(mcp.mcpServers ?? {});
        if (mcpServers.length > 0) evidence.push({ kind: "mcp", label: `שרתי MCP: ${mcpServers.join(", ")}`, weight: 6 });
      } catch { /* invalid */ }
    }
    if (contents.envExample && /anthropic|claude/i.test(contents.envExample)) {
      evidence.push({ kind: "env", label: "ANTHROPIC_API_KEY ב-.env.example — חיבור API בתשלום", weight: 12 });
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
    if (builtWithClaude) evidence.push({ kind: "readme", label: "ה-README מצהיר: נבנה עם Claude", weight: 6 });
    if (priceMentions.length > 0) evidence.push({ kind: "cost", label: `אזכורי עלות ב-README: ${priceMentions.slice(0, 3).join(", ")}`, weight: 5 });

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
      // רק מודלים מזכים (5.5+) — משפחת 4.x לא נסרקת ולא נחשבת כלל.
      // כל הרישום (6 מודלים) — בעבר slice(0,4) השמיט Opus 6.5/7 לחלוטין.
      const kws: [string, string, number][] = QUALIFYING_MODELS.map((m) => [
        m.searchStrings[0],
        m.label,
        m.weight,
      ]);
      for (const [kw, label, weight] of kws) {
        try {
          const r = await ghFetch<{ total_count: number }>(
            `/search/code?q=${encodeURIComponent(`repo:${full} "${kw}"`)}&per_page=1`,
            token
          );
          if (r.total_count > 0) addModel(kw, label, weight, "code-search", r.total_count, true);
        } catch (e) {
          if (e instanceof GhError && [403, 429].includes(e.status)) {
            warnings.push("חיפוש הקוד הושהה — מכסת החיפוש נגמרה זמנית");
            break;
          }
          // 422 = qualifier problem etc — continue silently
        }
        // מרווח קצר בין שאילתות קוד — מכסת code-search אגרסיבית (10 לדקה)
        await new Promise((r) => setTimeout(r, 1500));
      }
    } else {
      warnings.push("ללא טוקן לא מבוצע חיפוש קוד פנימי-מאגרי (רק סריקת קבצים מטא-נתונים)");
    }

    // זיהוי מטקסטים: settings / CLAUDE.md / README — הפרדה מלאה בין מזכים (5.5+) לחסומים (4.x ומטה)
    const textDetection = detectClaudeModels(
      `${settingsModelText} ${contents.claudeMd ?? ""} ${readme.slice(0, 4000)}`
    );
    for (const m of textDetection.qualifying) {
      const source = settingsModelText.toLowerCase().includes(m.id) ? "settings" : contents.claudeMd?.toLowerCase().includes(m.id) ? "claude-md" : "readme";
      addModel(m.id, m.label, m.weight, source, undefined, true, m.version);
    }
    // חסומים (4.x ומטה): מוצגים לשקיפות בלבד — משקל 0, לא נכללים בציון
    for (const b of textDetection.blocked) {
      const source = settingsModelText.toLowerCase().includes(b.id) ? "settings" : contents.claudeMd?.toLowerCase().includes(b.id) ? "claude-md" : "readme";
      addModel(b.id, b.label, 0, source, undefined, false, b.version);
    }

    const modelList = Array.from(models.values()).sort((a, b) => b.weight - a.weight);
    const qualifyingList = modelList.filter((m) => m.qualifying);
    const blockedList = modelList.filter((m) => !m.qualifying);

    // ---------- scoring ----------
    // ציון מודלים: מזכים בלבד. אין 5.5+ → אפס נקודות מודל.
    const modelScore = qualifyingList.length > 0 ? Math.min(45, qualifyingList[0].weight) : 0;
    const paidScore = Math.min(30, evidence.reduce((s, e) => s + e.weight, 0));
    const tractionScore = Math.min(
      25,
      satScore(meta.stargazers_count, 15, 10000) + satScore(meta.forks_count, 5, 1000) + satScore(contributors, 5, 30)
    );
    const usageScore = Math.min(15, priceMentions.length * 3 + tokenMentions.length * 2 + Math.min(claudeCodeMentions, 4) + (builtWithClaude ? 3 : 0));
    // חוק הסף — רק ריפו שמוכיח 5.5+ יכול להגיע לטירות הפרימיום (זהב/אליטה):
    // בלי מודל מזכה הציון מוגבל ל-35 (מתחת לכסף) — ריפו עם רק 4.x לא יכול להיראות "זהב"
    // (בעבר: paid+traction+usage הגיעו ל-70/100 על ריפו של 4.x בלבד)
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
    if (!meetsModelThreshold) {
      // פסיקה מחמירה: אין מודל 5.5+ → לא פרויקט פרימיום לפי הקריטריון
      insights.push(
        blockedList.length > 0
          ? `⛔ לא עומד בסף: זוהו רק מודלים חסומים (${blockedList.map((b) => b.label).join(", ")}) — הקריטריון מחייב 5.5 ומעלה (Opus 5.5, Fable, Opus 6+)`
          : `⛔ לא עומד בסף: לא זוהה אף מודל 5.5+ — הקריטריון מחייב Opus 5.5, Fable או חדש יותר`
      );
      // שקיפות: מה בדיוק חתך את הציון
      insights.push(`ציון גולמי ${rawTotal} חתוך ל-${total} — בלי הוכחת מודל 5.5+ לא מוענקות טירות פרימיום`);
    } else {
      insights.push(`✅ עומד בסף המודלים (5.5+): ${qualifyingList.map((m) => m.label).join(", ")}${blockedList.length > 0 ? ` — וגם אזכורים חסומים של ${blockedList.map((b) => b.label).join(", ")} (לא נחשבים)` : ""}`);
    }
    if (contents.claudeMd) insights.push("יש CLAUDE.md — שווה ללמוד את מבנה ההוראות, הגבולות וזרימות העבודה שהוגדרו שם ולהתאים אותם לממשק שלנו");
    if (commands.length > 0) insights.push(`${commands.length} פקודות מותאמות (${commands.slice(0, 5).join(", ")}) — אפשר לאמץ את הרעיונות לפקודות דומות`);
    if (agents.length > 0) insights.push(`${agents.length} סוכני משנה מוגדרים (${agents.slice(0, 5).join(", ")}) — ארכיטקטורת multi-agent מוכחה לחיקוי`);
    if (mcpServers.length > 0) insights.push(`שרתי MCP פעילים (${mcpServers.join(", ")}) — אינטגרציות כלים שאפשר לחבר גם אצלנו`);
    if (qualifyingList.some((m) => m.weight >= 40)) insights.push("משתמש במודל דגל 5.5+ (Opus 5.5/Fable ומעלה) — הפרויקט מוכיח שהמשימות מצדיקות מודל יקר; כדאי לבחון אילו זרימות מנצלות את זה");
    if (depsFound.length > 0) insights.push(`ערימת SDK: ${depsFound.join(", ")} — נקודת פתיחה טובה להבנת האינטגרציה`);
    if (priceMentions.length > 0 || tokenMentions.length > 0) insights.push("יש אזכורי עלות/טוקנים ב-README — אינדיקציה לשימוש אמיתי בתשלום בהיקף משמעותי");
    if (contributors > 5) insights.push(`${contributors} תורמים — פרויקט חי עם קהילה, לא ניסוי אישי`);

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
      const friendly = e.status === 404 ? `המאגר ${full} לא נמצא ב-GitHub (404) — בדוק את הכתובת` : e.message;
      return NextResponse.json({ error: friendly }, { status: e.status });
    }
    console.error("analyze failed", e);
    return NextResponse.json({ error: "הניתוח נכשל. נסה שוב." }, { status: 500 });
  }
}
