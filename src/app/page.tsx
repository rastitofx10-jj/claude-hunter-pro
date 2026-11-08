"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Radar,
  AlertTriangle,
  Github,
  Search,
  Bookmark,
  Swords,
  Target,
  Satellite,
  Dna,
  History as HistoryIcon,
  LayoutDashboard,
  Command as CommandIcon,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { useHunterStore, type TabKey } from "@/lib/hunter-store";
import { apiFetch, parseRepoInputClient } from "@/lib/api-client";
import { THRESHOLD_RULE_TEXT, THRESHOLD_LABEL } from "@/lib/claude-models";
import type { AnalyzeResponse, SearchBody, SearchResponse, ScoredRepo, WatchItem } from "@/lib/hunter-types";
import { SearchPanel, SEARCH_DEFAULTS } from "@/components/hunter/search-panel";
import { ResultsSection } from "@/components/hunter/results-section";
import { AnalyzeSheet, type AnalyzeTarget } from "@/components/hunter/analyze-sheet";
import { WatchlistPanel } from "@/components/hunter/watchlist-panel";
import { GenesisPanel } from "@/components/hunter/genesis-panel";
import { MissionControlPanel } from "@/components/hunter/mission-control";
import { SweepPanel } from "@/components/hunter/sweep-panel";
import { LiveHuntPanel } from "@/components/hunter/live-hunt-panel";
import { HistoryPanel } from "@/components/hunter/history-panel";
import { RateChip } from "@/components/hunter/rate-chip";
import { TokenBanner } from "@/components/hunter/token-banner";
import { ThemeToggle } from "@/components/hunter/theme-toggle";
import { CommandPalette } from "@/components/hunter/command-palette";
import { Overview } from "@/components/hunter/overview";
import type { Recipe } from "@/lib/hunter-recipes";

export default function ClaudeHunterPage() {
  const token = useHunterStore((s) => s.token);
  const activeTab = useHunterStore((s) => s.activeTab);
  const setActiveTab = useHunterStore((s) => s.setActiveTab);
  const qc = useQueryClient();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchBody, setSearchBody] = useState<SearchBody>({ ...SEARCH_DEFAULTS, page: 1 });
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [analyzeTarget, setAnalyzeTarget] = useState<AnalyzeTarget | null>(null);

  // analyze requests can arrive from anywhere (palette, recipes, cards, watchlist)
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ owner: string; repo: string }>).detail;
      if (d?.owner && d?.repo) setAnalyzeTarget({ owner: d.owner, repo: d.repo });
    };
    window.addEventListener("hunter-analyze", handler);
    return () => window.removeEventListener("hunter-analyze", handler);
  }, []);

  // watchlist (also feeds the saved-state on cards + nav badge)
  const { data: watchData } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiFetch<{ items: WatchItem[] }>("/api/watchlist", token),
  });
  const savedNames = useMemo(() => new Set((watchData?.items ?? []).map((w) => w.fullName)), [watchData]);

  const { data: missionData } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiFetch<{ items: unknown[] }>("/api/mission", token),
  });

  const saveRepo = useMutation({
    mutationFn: (payload: {
      fullName: string;
      owner: string;
      name: string;
      url: string;
      description?: string | null;
      stars?: number;
      score?: number;
      models?: string | null;
    }) => apiFetch("/api/watchlist", token, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "נשמר לרשימה ✅", description: "המאגר נוסף ללוח המקורות שלך" });
    },
    onError: (e: Error) => toast({ title: "השמירה נכשלה", description: e.message, variant: "destructive" }),
  });

  const saveFromScored = useCallback(
    (item: ScoredRepo) => {
      // models מושמט במכוון: null מפורש נחשב פעם ל"אין מודלים" ומחק נתונים קיימים בשרת
      saveRepo.mutate({
        fullName: item.fullName,
        owner: item.owner?.login ?? item.fullName.split("/")[0],
        name: item.fullName.split("/").slice(1).join("/"),
        url: item.htmlUrl,
        description: item.description ?? null,
        stars: item.stars,
        score: item.score,
      });
    },
    [saveRepo]
  );

  const search = useMutation({
    mutationFn: (body: SearchBody) =>
      apiFetch<SearchResponse>("/api/search", token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      setResults(data);
      if (data.items.length === 0) {
        toast({ title: "אין תוצאות", description: "נסה להרפות מסננים או לשנות את השאילתה" });
      }
    },
    onError: (e: Error) => {
      toast({ title: "החיפוש נכשל", description: e.message, variant: "destructive" });
    },
  });

  const runSearch = useCallback(
    (body: SearchBody) => {
      search.mutate(body);
    },
    [search]
  );

  const analyzeFromName = useCallback((fullName: string) => {
    const parsed = parseRepoInputClient(fullName);
    if (parsed) setAnalyzeTarget(parsed);
  }, []);

  const applyRecipe = useCallback(
    (r: Recipe) => {
      const body: SearchBody = { ...SEARCH_DEFAULTS, ...r.body, page: 1 };
      setSearchBody(body);
      setActiveTab("search");
      runSearch(body); // מתכון = כוונת חיפוש מובהקת — רצים מיד, לא רק ממלאים טופס
    },
    [setActiveTab, runSearch]
  );

  // ---------- navigation model ----------

  const navItems: {
    tab: TabKey;
    label: string;
    icon: typeof Search;
    badge?: string;
    badgeTone?: "amber" | "orange" | "violet";
  }[] = [
    { tab: "home", label: "בית", icon: LayoutDashboard },
    { tab: "live", label: "ציד חי", icon: Swords },
    { tab: "mission", label: "מבצעים", icon: Target, badge: missionData?.items.length ? String(missionData.items.length) : undefined },
    { tab: "sweep", label: "סריקה", icon: Satellite },
    { tab: "genesis", label: "Genesis", icon: Dna },
    { tab: "search", label: "חיפוש", icon: Search },
    { tab: "watchlist", label: "נשמרים", icon: Bookmark, badge: (watchData?.items?.length ?? 0) > 0 ? String(watchData?.items?.length ?? 0) : undefined },
    { tab: "history", label: "היסטוריה", icon: HistoryIcon },
  ];

  const renderTab = () => {
    switch (activeTab) {
      case "home":
        return <Overview onNavigate={setActiveTab} />;
      case "search":
        return (
          <div className="space-y-5">
            <SearchPanel
              value={searchBody}
              onChange={(b) => setSearchBody({ ...b, page: b.page ?? 1 })}
              onSearch={() => runSearch({ ...searchBody, page: 1 })}
              loading={search.isPending}
            />
            {search.isPending && !results && (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-52 animate-pulse rounded-xl border bg-muted/40" />
                ))}
              </div>
            )}
            {results && (
              <ResultsSection
                items={results.items}
                totalMatches={results.totalMatches}
                repoCount={results.repoCount}
                mode={results.mode}
                querySent={results.querySent}
                canPaginate={results.canPaginate !== false && results.mode === "repos"}
                blockedHidden={results.blockedHidden}
                page={searchBody.page ?? 1}
                perPage={searchBody.perPage ?? 24}
                loading={search.isPending}
                onPage={(p) => {
                  const b = { ...searchBody, page: p };
                  setSearchBody(b);
                  runSearch(b);
                }}
                onAnalyze={analyzeFromName}
                onSave={saveFromScored}
                savedNames={savedNames}
              />
            )}
            {!results && !search.isPending && (
              <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
                <p className="text-4xl">🏹</p>
                <p className="mt-2 font-medium">התחילו לצוד</p>
                <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed">
                  בחרו מתכון מוכן (או <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl</kbd>+
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">K</kbd>), או חפשו קוד
                  למחרוזות מודל פרימיום כמו <code dir="ltr" className="font-mono">claude-opus-5-5</code> — הראיה הישירה
                  לכך שמישהו משלם על טוקנים.
                  <span className="mt-1 block text-xs font-medium text-orange-700 dark:text-orange-300">
                    🔒 הסף נעול: רק מודלים {THRESHOLD_LABEL} — משפחת 4.x נחסמת בשרת.
                  </span>
                </p>
              </div>
            )}
          </div>
        );
      case "watchlist":
        return <WatchlistPanel onAnalyze={analyzeFromName} />;
      case "sweep":
        return <SweepPanel />;
      case "history":
        return (
          <HistoryPanel
            onReRun={(body) => {
              setActiveTab("search");
              const merged = { ...SEARCH_DEFAULTS, ...body, page: 1 };
              setSearchBody(merged);
              runSearch(merged);
            }}
          />
        );
      case "genesis":
        return <GenesisPanel />;
      case "mission":
        return <MissionControlPanel />;
      case "live":
        return <LiveHuntPanel />;
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-orange-50/50 via-background to-background dark:from-orange-950/10" dir="rtl">
      {/* ---------- top bar ---------- */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-md">
              <Radar className="h-4.5 w-4.5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight">
                Claude Hunter <span className="text-orange-600">🎯</span>
              </h1>
              <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
                מודיעין תחרותי לפרויקטי Claude פרימיום — סף 5.5+ נעול בקוד
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 font-mono"
              onClick={() => setPaletteOpen(true)}
              title="פקודות מהירות (Ctrl+K)"
            >
              <CommandIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Ctrl K</span>
            </Button>
            <span
              title={THRESHOLD_RULE_TEXT}
              className="hidden rounded-full border border-orange-300 bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 md:inline-flex dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300"
            >
              🔒 {THRESHOLD_LABEL} בלבד · 4.x חסום
            </span>
            <RateChip />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-0 px-0 lg:gap-6 lg:px-4">
        {/* ---------- sidebar (desktop) ---------- */}
        <nav aria-label="ניווט ראשי" className="hidden w-56 shrink-0 py-6 lg:block">
          <ul className="sticky top-20 space-y-1">
            {navItems.map((n) => {
              const active = activeTab === n.tab;
              return (
                <li key={n.tab}>
                  <button
                    onClick={() => setActiveTab(n.tab)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-gradient-to-l from-orange-100 to-transparent text-orange-800 dark:from-orange-950/60 dark:text-orange-200"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-pill"
                        className="absolute inset-y-1.5 right-0 w-1 rounded-full bg-gradient-to-b from-orange-500 to-amber-500"
                        transition={{ type: "spring", stiffness: 350, damping: 30 }}
                      />
                    )}
                    <n.icon className={`h-4.5 w-4.5 ${active ? "text-orange-600 dark:text-orange-300" : ""}`} aria-hidden />
                    <span className="flex-1 text-start">{n.label}</span>
                    {n.badge && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px] tabular-nums">
                        {n.badge}
                      </Badge>
                    )}
                    {n.tab === "live" && active && <Loader2 className="h-3 w-3 animate-spin text-amber-500" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ---------- mobile nav ---------- */}
        <div className="w-full lg:hidden">
          <nav aria-label="ניווט ראשי" className="sticky top-[57px] z-30 border-b bg-background/90 backdrop-blur">
            <ul className="flex gap-1 overflow-x-auto px-3 py-2" style={{ scrollbarWidth: "none" }}>
              {navItems.map((n) => {
                const active = activeTab === n.tab;
                return (
                  <li key={n.tab} className="shrink-0">
                    <button
                      onClick={() => setActiveTab(n.tab)}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? "bg-orange-600 text-white shadow"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <n.icon className="h-3.5 w-3.5" aria-hidden />
                      {n.label}
                      {n.badge && <span className="tabular-nums opacity-80">({n.badge})</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* ---------- content ---------- */}
        <main className="min-w-0 flex-1 py-6">
          <TokenBanner />
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="mt-4"
          >
            {renderTab()}
          </motion.div>
        </main>
      </div>

      {/* ---------- footer (sticky bottom) ---------- */}
      <footer className="mt-auto border-t bg-muted/30 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Radar className="h-3.5 w-3.5" /> Claude Hunter — מדד ההשקעה הוא היוריסטיקה, לא עובדה מוחלטת
          </span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> השתמשו באחריות: כבדו רישיונות מאגרים ותנאי שימוש
            </span>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" /> נתוני GitHub API
            </a>
          </span>
        </div>
      </footer>

      <AnalyzeSheet
        target={analyzeTarget}
        onClose={() => setAnalyzeTarget(null)}
        onSaveRepo={(a: AnalyzeResponse) => {
          saveRepo.mutate({
            fullName: a.repo.fullName,
            owner: a.repo.owner?.login ?? a.repo.fullName.split("/")[0],
            name: a.repo.fullName.split("/").slice(1).join("/"),
            url: a.repo.htmlUrl,
            description: a.repo.description ?? null,
            stars: a.repo.stars,
            score: a.score.total,
            models: a.models.map((m) => m.label).join(",") || null,
          });
        }}
      />

      <CommandPalette
        open={paletteOpen}
        setOpen={setPaletteOpen}
        actions={{
          onNavigate: setActiveTab,
          onRecipe: applyRecipe,
          onAnalyze: (owner, repo) => setAnalyzeTarget({ owner, repo }),
        }}
      />
    </div>
  );
}
