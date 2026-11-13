import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { GhError, ghFetch, computeListScore, isBlockedModelString, THRESHOLD_RULE_TEXT } from "@/lib/github";
import { batchRepoMeta } from "@/lib/harvester";
import type { SearchBody, ScoredRepo, RepoCore, CodeMatch } from "@/lib/hunter-types";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** Input sanitization for the URL — previously inserted raw from the client (the index could inject qualifiers) */
const SORT_ENUM = new Set(["stars", "forks", "updated", "best"]);
const LANG_RE = /^[\w.+#-]{1,24}$/; // GitHub language names: C++, C#, Objective-C

interface GhRepoItem {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count?: number;
  open_issues_count?: number;
  language: string | null;
  topics?: string[];
  pushed_at: string;
  created_at: string;
  size: number;
  archived: boolean;
  license?: { spdx_id?: string } | null;
  owner: { login: string; type?: string; avatar_url?: string };
}

interface GhCodeItem {
  name: string;
  path: string;
  html_url: string;
  repository?: GhRepoItem;
}

interface GhSearchResp<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

function mapRepo(r: GhRepoItem): RepoCore {
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner ? { login: r.owner.login, type: r.owner.type, avatar_url: r.owner.avatar_url } : undefined,
    htmlUrl: r.html_url,
    description: r.description,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    watchers: r.watchers_count,
    openIssues: r.open_issues_count,
    language: r.language,
    topics: r.topics ?? [],
    pushedAt: r.pushed_at,
    createdAt: r.created_at,
    size: r.size,
    archived: r.archived,
    license: r.license?.spdx_id ?? null,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const token = await resolveToken(req);
  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // round 8: the body was only `as SearchBody`-cast — a JSON null body or wrong-typed
  // fields ({"model":5}, {"topics":5}) crashed BEFORE the route's try block → a raw
  // framework 500 that broke the JSON error contract. Narrow first, 400 otherwise
  // (the same discipline mission/route.ts already applies).
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    return NextResponse.json({ error: "model must be a string" }, { status: 400 });
  }
  if (body.topics !== undefined && !Array.isArray(body.topics)) {
    return NextResponse.json({ error: "topics must be an array" }, { status: 400 });
  }
  if (body.query !== undefined && typeof body.query !== "string") {
    return NextResponse.json({ error: "query must be a string" }, { status: 400 });
  }
  if (body.language !== undefined && typeof body.language !== "string") {
    return NextResponse.json({ error: "language must be a string" }, { status: 400 });
  }
  if (body.sort !== undefined && typeof body.sort !== "string") {
    return NextResponse.json({ error: "sort must be a string" }, { status: 400 });
  }

  const mode = body.mode === "code" ? "code" : "repos";
  const perPage = Math.min(Math.max(body.perPage ?? 24, 6), 60);
  const page = Math.max(body.page ?? 1, 1);

  // ⛔ Strict server-side blocking: a model filter below the threshold (4.x and below) is rejected immediately
  if (body.model?.trim() && isBlockedModelString(body.model.trim())) {
    return NextResponse.json(
      { error: `⛔ Blocked model: ${THRESHOLD_RULE_TEXT}` },
      { status: 400 }
    );
  }

  const parts: string[] = [];
  const q = (body.query ?? "").trim();
  if (q) parts.push(q);
  // topic: not supported in code search (guaranteed 422) — previously injected in both modes
  // and it broke the UX of a common combo: topic + code mode.
  if (mode === "repos") {
    for (const t of body.topics ?? []) if (t.trim()) parts.push(`topic:${t.trim()}`);
  }
  if (body.model?.trim()) parts.push(`"${body.model.trim()}"`);
  // Language: validation + safe assembly — previously free text from the client was injected straight into the URL
  const lang = body.language?.trim() ?? "";
  if (lang && LANG_RE.test(lang)) parts.push(`language:${lang}`);

  if (mode === "repos") {
    if (body.minStars && body.minStars > 0) parts.push(`stars:>=${body.minStars}`);
    if (body.pushedWithinDays && body.pushedWithinDays > 0) parts.push(`pushed:>=${daysAgoIso(body.pushedWithinDays)}`);
    parts.push("fork:false");
  } else {
    // code search needs at least one term, not only qualifiers
    const hasTerm = q || body.model?.trim();
    if (!hasTerm && (body.hasClaudeMd || (body.topics?.length ?? 0) > 0)) parts.push("claude");
    if (body.hasClaudeMd) parts.push("filename:CLAUDE.md");
    if (!q && !body.model?.trim() && !body.hasClaudeMd) {
      return NextResponse.json(
        { error: "Code search requires text, a model, or the CLAUDE.md flag" },
        { status: 400 }
      );
    }
  }

  const querySent = parts.join(" ").trim();
  if (!querySent) {
    return NextResponse.json({ error: "At least one search condition is required" }, { status: 400 });
  }

  // Validation instead of blind trust — previously a raw sort from the client was injected into the URL
  const sort = body.sort && SORT_ENUM.has(body.sort) ? body.sort : "best";
  const sortQ = mode === "repos" && sort !== "best" ? `&sort=${encodeURIComponent(sort)}&order=desc` : "";

  try {
    if (mode === "repos") {
      const data = await ghFetch<GhSearchResp<GhRepoItem>>(
        `/search/repositories?q=${encodeURIComponent(querySent)}&per_page=${perPage}&page=${page}${sortQ}`,
        token
      );
      // The token from the header was validated against GitHub — saved for server use
      await captureTokenFrom(req);
      // ⛔ Full blocking rule: repos showing *only* 4.x and below models — completely hidden from the results
      let items: ScoredRepo[] = [];
      let blockedHidden = 0;
      for (const r of data.items) {
        const core = mapRepo(r);
        const s = computeListScore(core);
        if (s.blockedOnly) {
          blockedHidden++;
          continue;
        }
        items.push({ ...core, score: s.score, tier: s.tier, reasons: s.reasons });
      }
      if (body.ownerType && body.ownerType !== "any") {
        items = items.filter((i) => i.owner?.type === (body.ownerType === "user" ? "User" : "Organization"));
      }
      // Smart history: a new page in the same search does not create a new row — previously paging through
      // 5 pages created 5 identical rows and the history never converged.
      const filtersKey = JSON.stringify({ ...body, page: undefined });
      try {
        const last = await db.searchHistory.findFirst({ orderBy: { id: "desc" }, select: { mode: true, query: true, filters: true } });
        const lastKey = last ? JSON.stringify({
          mode: last.mode,
          query: last.query,
          // Old rows were written with page inside the filters — normalize before comparing
          filters: last.filters ? JSON.stringify({ ...JSON.parse(last.filters), page: undefined }) : "",
        }) : "";
        const thisKey = JSON.stringify({ mode, query: querySent, filters: filtersKey });
        if (lastKey !== thisKey) {
          await db.searchHistory.create({
            data: { mode, query: querySent, filters: filtersKey, resultCount: items.length },
          });
        }
      } catch {
        // history is non critical
      }
      return NextResponse.json({
        mode,
        totalMatches: data.total_count,
        items,
        querySent,
        blockedHidden,
      });
    }

    // ---- code mode ----
    if (!token) {
      return NextResponse.json(
        { error: "GitHub code search requires a Personal Access Token. Add one in Settings (free, 30 seconds)." },
        { status: 401 }
      );
    }
    const data = await ghFetch<GhSearchResp<GhCodeItem>>(
      `/search/code?q=${encodeURIComponent(querySent)}&per_page=100&page=1`,
      token
    );
    // The token from the header was validated against GitHub — saved for server use
    await captureTokenFrom(req);

    const groups = new Map<string, { repo: RepoCore; matches: CodeMatch[] }>();
    for (const item of data.items ?? []) {
      const r = item.repository;
      if (!r?.full_name) continue;
      const g = groups.get(r.full_name);
      const match: CodeMatch = { path: item.path, htmlUrl: item.html_url };
      if (g) {
        g.matches.push(match);
      } else {
        groups.set(r.full_name, { repo: mapRepo(r), matches: [match] });
      }
    }

    // Star enrichment for code search: the repository object in the REST response does not include
    // stargazers_count ("minimal") — previously every code-mode card showed ⭐0, the token investment score
    // got 0 pull-cost and star sorting was meaningless. Now: 1-2 GraphQL calls
    // (cost of 1 point, the same mechanism proven in the harvester) return real stars.
    const needStars = Array.from(groups.values()).filter((g) => (g.repo.stars ?? 0) === 0).map((g) => g.repo.fullName);
    if (needStars.length > 0) {
      const metaMap = await batchRepoMeta(needStars, token);
      for (const g of groups.values()) {
        const m = metaMap.get(g.repo.fullName);
        if (m && m.stars > 0) g.repo.stars = m.stars;
      }
    }

    // ⛔ Full blocking rule in code mode too: repos showing only 4.x — hidden
    let blockedHidden = 0;
    let items: ScoredRepo[] = [];
    for (const { repo, matches } of groups.values()) {
      const s = computeListScore(repo);
      if (s.blockedOnly) {
        blockedHidden++;
        continue;
      }
      items.push({ ...repo, score: s.score, tier: s.tier, reasons: s.reasons, matches: matches.slice(0, 4), matchCount: matches.length });
    }

    if (body.ownerType && body.ownerType !== "any") {
      items = items.filter((i) => i.owner?.type === (body.ownerType === "user" ? "User" : "Organization"));
    }
    if (sort === "stars") items.sort((a, b) => b.stars - a.stars);
    else if (sort === "updated") items.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    else if (sort === "forks") items.sort((a, b) => b.forks - a.forks);
    else items.sort((a, b) => b.score - a.score);
    items = items.slice(0, 30);

    // Smart history (same as repos mode) — a repeated page/run does not duplicate rows
    const codeFiltersKey = JSON.stringify({ ...body, page: undefined });
    try {
      const last = await db.searchHistory.findFirst({ orderBy: { id: "desc" }, select: { mode: true, query: true, filters: true } });
      const lastKey = last ? JSON.stringify({
        mode: last.mode,
        query: last.query,
        filters: last.filters ? JSON.stringify({ ...JSON.parse(last.filters), page: undefined }) : "",
      }) : "";
      const thisKey = JSON.stringify({ mode, query: querySent, filters: codeFiltersKey });
      if (lastKey !== thisKey) {
        await db.searchHistory.create({
          data: { mode, query: querySent, filters: codeFiltersKey, resultCount: items.length },
        });
      }
    } catch {
      // non critical
    }

    return NextResponse.json({
      mode,
      totalMatches: data.total_count,
      // What the user actually received — previously blocked/filtered repos hidden from them were also counted
      repoCount: items.length,
      items,
      // ⚠️ code mode = always a single page: GitHub code search is limited to 100 results
      // per query with no real pagination — the UI hides pagination in code mode when this field is false
      // (previously: fake pagination — pages 2-3 returned exactly the same repos)
      canPaginate: false,
      incompleteResults: !!data.incomplete_results,
      note: data.incomplete_results
        ? "The search index is partial for this query (incomplete_results) — results may be incomplete"
        : "Code search returns up to 100 files per query; results are grouped by repo and ranked by the token investment score",
      querySent,
      blockedHidden,
    });
  } catch (e) {
    if (e instanceof GhError) {
      return NextResponse.json({ error: e.message }, { status: e.status === 422 ? 400 : e.status });
    }
    console.error("search failed", e);
    return NextResponse.json({ error: "Search failed. Try again." }, { status: 500 });
  }
}
