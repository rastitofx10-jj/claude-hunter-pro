import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { GhError, ghFetch, computeListScore, isBlockedModelString, THRESHOLD_RULE_TEXT } from "@/lib/github";
import { batchRepoMeta } from "@/lib/harvester";
import type { SearchBody, ScoredRepo, RepoCore, CodeMatch } from "@/lib/hunter-types";
import { captureTokenFrom, resolveToken } from "@/lib/server-token";

export const dynamic = "force-dynamic";

/** אינטרזו ל-URL — בעבר הוכנס גולמי מהלקוח (אינדקס עלול להזריק qualifiers) */
const SORT_ENUM = new Set(["stars", "forks", "updated", "best"]);
const LANG_RE = /^[\w.+#-]{1,24}$/; // שמות שפות של GitHub: C++, C#, Objective-C

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
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }

  const mode = body.mode === "code" ? "code" : "repos";
  const perPage = Math.min(Math.max(body.perPage ?? 24, 6), 60);
  const page = Math.max(body.page ?? 1, 1);

  // ⛔ חסימת שרת מחמירה: מסנן מודל מתחת לסף (4.x ומטה) נדחה מיד
  if (body.model?.trim() && isBlockedModelString(body.model.trim())) {
    return NextResponse.json(
      { error: `⛔ מודל חסום: ${THRESHOLD_RULE_TEXT}` },
      { status: 400 }
    );
  }

  const parts: string[] = [];
  const q = (body.query ?? "").trim();
  if (q) parts.push(q);
  // topic: אינו נתמך בחיפוש קוד (422 מובטח) — בעבר הוזרק בשני המצבים
  // ושבר את ה-UX של שילוב נפוץ: נושא + מצב קוד.
  if (mode === "repos") {
    for (const t of body.topics ?? []) if (t.trim()) parts.push(`topic:${t.trim()}`);
  }
  if (body.model?.trim()) parts.push(`"${body.model.trim()}"`);
  // שפה: ולידציה + הרכבה בטוחה — בעבר טקסט חופשי מהלקוח הוזרק ישר ל-URL
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
        { error: "בחיפוש קוד נדרש טקסט, מודל, או סימון CLAUDE.md" },
        { status: 400 }
      );
    }
  }

  const querySent = parts.join(" ").trim();
  if (!querySent) {
    return NextResponse.json({ error: "נדרש תנאי חיפוש אחד לפחות" }, { status: 400 });
  }

  // ולידציה במקום אמון עץ-בעץ — בעבר sort גולמי מהלקוח הוזרק ל-URL
  const sort = body.sort && SORT_ENUM.has(body.sort) ? body.sort : "best";
  const sortQ = mode === "repos" && sort !== "best" ? `&sort=${encodeURIComponent(sort)}&order=desc` : "";

  try {
    if (mode === "repos") {
      const data = await ghFetch<GhSearchResp<GhRepoItem>>(
        `/search/repositories?q=${encodeURIComponent(querySent)}&per_page=${perPage}&page=${page}${sortQ}`,
        token
      );
      // הטוקן מהכותרת עבר אימות מול GitHub — נשמר לשימוש השרת
      await captureTokenFrom(req);
      // ⛔ חוק החסימה המלאה: מאגרים שמציגים *רק* מודלי 4.x ומטה — מוסתרים לחלוטין מהתוצאות
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
      // היסטוריה חכמה: דף חדש באותו חיפוש לא יוצר שורה חדשה — בעבר דפדוף בין
      // 5 עמודים יצר 5 שורות זהות וההיסטוריה לא התכנסה אף פעם.
      const filtersKey = JSON.stringify({ ...body, page: undefined });
      try {
        const last = await db.searchHistory.findFirst({ orderBy: { id: "desc" }, select: { mode: true, query: true, filters: true } });
        const lastKey = last ? JSON.stringify({
          mode: last.mode,
          query: last.query,
          // שורות ישנות נכתבו עם page בתוך ה-filters — מנרמל לפני ההשוואה
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
        { error: "חיפוש קוד ב-GitHub דורש Personal Access Token. הוסף אותו בהגדרות (חינם, 30 שניות)." },
        { status: 401 }
      );
    }
    const data = await ghFetch<GhSearchResp<GhCodeItem>>(
      `/search/code?q=${encodeURIComponent(querySent)}&per_page=100&page=1`,
      token
    );
    // הטוקן מהכותרת עבר אימות מול GitHub — נשמר לשימוש השרת
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

    // העשרת כוכבים לפי חיפוש-קוד: אובייקט ה-repository בתשובת REST אינו כולל
    // stargazers_count ("minimal") — בעבר כל כרטיס מצב קוד הציג ⭐0, מדד ההשקעה
    // קיבל 0 עלות-משיכה ומיון כוכבים היה חסר משמעות. עכשיו: 1-2 קריאות GraphQL
    // (עלות 1 נקודה, אותו מנגנון שהוכח ב-harvester) מחזירות כוכבים אמיתיים.
    const needStars = Array.from(groups.values()).filter((g) => (g.repo.stars ?? 0) === 0).map((g) => g.repo.fullName);
    if (needStars.length > 0) {
      const metaMap = await batchRepoMeta(needStars, token);
      for (const g of groups.values()) {
        const m = metaMap.get(g.repo.fullName);
        if (m && m.stars > 0) g.repo.stars = m.stars;
      }
    }

    // ⛔ חוק החסימה המלאה גם במצב קוד: מאגרים שמציגים רק 4.x — מוסתרים
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

    // היסטוריה חכמה (זהה למצב מאגרים) — דף/ריצה חוזרת לא מכפילה שורות
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
      // מה שהמשתמש באמת קיבל — בעבר נספרו גם מאגרים חסומים/מסוננים שהוסתרו ממנו
      repoCount: items.length,
      items,
      // ⚠️ code mode = עמוד אחד תמיד: GitHub code search מוגבל ל-100 תוצאות
      // לשאילתה ללא עימוד אמיתי — ה-UI לא מציג עימוד במצב קוד כשהשדה הזה false
      // (בעבר: עימוד פיקטיבי — עמודים 2-3 החזירו בדיוק את אותם מאגרים)
      canPaginate: false,
      incompleteResults: !!data.incomplete_results,
      note: data.incomplete_results
        ? "אינדקס החיפוש חלקי לשאילתה זו (incomplete_results) — התוצאות עשויות להיות לא מלאות"
        : "חיפוש קוד מחזיר עד 100 קבצים לשאילתה; התוצאות מקובצות לפי מאגר ומדורגות לפי מדד ההשקעה",
      querySent,
      blockedHidden,
    });
  } catch (e) {
    if (e instanceof GhError) {
      return NextResponse.json({ error: e.message }, { status: e.status === 422 ? 400 : e.status });
    }
    console.error("search failed", e);
    return NextResponse.json({ error: "החיפוש נכשל. נסה שוב." }, { status: 500 });
  }
}
