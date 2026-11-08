"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, Github, AlertTriangle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { useHunterStore } from "@/lib/hunter-store";
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

const QUICK_REPOS: { label: string; fullName: string }[] = [
  { label: "🎭 storytold/craft-anything", fullName: "storytold/craft-anything" },
  { label: "📚 public-apis/public-apis", fullName: "public-apis/public-apis" },
];

type TabKeyUnion = "search" | "watchlist" | "sweep" | "history" | "genesis" | "mission" | "live";

export default function ClaudeHunterPage() {
  const token = useHunterStore((s) => s.token);
  const activeTab = useHunterStore((s) => s.activeTab);
  const setActiveTab = useHunterStore((s) => s.setActiveTab);
  const qc = useQueryClient();

  const [searchBody, setSearchBody] = useState<SearchBody>({ ...SEARCH_DEFAULTS, page: 1 });
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [analyzeTarget, setAnalyzeTarget] = useState<AnalyzeTarget | null>(null);
  const [quickInput, setQuickInput] = useState("");

  // listen for analyze requests from recipes
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ owner: string; repo: string }>).detail;
      if (d?.owner && d?.repo) setAnalyzeTarget({ owner: d.owner, repo: d.repo });
    };
    window.addEventListener("hunter-analyze", handler);
    return () => window.removeEventListener("hunter-analyze", handler);
  }, []);

  // watchlist (also used for saved-state in cards)
  const { data: watchData } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiFetch<{ items: WatchItem[] }>("/api/watchlist", token),
  });
  const savedNames = useMemo(() => new Set((watchData?.items ?? []).map((w) => w.fullName)), [watchData]);

  const saveRepo = useMutation({
    mutationFn: (payload: { fullName: string; owner: string; name: string; url: string; description?: string | null; stars?: number; score?: number; models?: string | null }) =>
      apiFetch("/api/watchlist", token, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "נשמר לרשימה ✅", description: "המאגר נוסף ללוח המקורות שלך" });
    },
    onError: (e: Error) => toast({ title: "השמירה נכשלה", description: e.message, variant: "destructive" }),
  });

  const saveFromScored = useCallback(
    (item: ScoredRepo) => {
      saveRepo.mutate({
        fullName: item.fullName,
        owner: item.owner?.login ?? item.fullName.split("/")[0],
        name: item.fullName.split("/").slice(1).join("/"),
        url: item.htmlUrl,
        description: item.description ?? null,
        stars: item.stars,
        score: item.score,
        models: null,
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
      toast({
        title: "החיפוש נכשל",
        description: e.message,
        variant: "destructive",
      });
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

  const quickAnalyze = useCallback(
    (raw: string) => {
      const parsed = parseRepoInputClient(raw);
      if (!parsed) {
        toast({ title: "כתובת לא תקינה", description: "הדבק github.com/owner/repo או owner/repo", variant: "destructive" });
        return;
      }
      setAnalyzeTarget(parsed);
    },
    []
  );

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-orange-50/60 via-background to-background dark:from-orange-950/10">
      {/* header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-md">
              <Radar className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">
                Claude Hunter <span className="text-orange-600">🎯</span>
              </h1>
              <p className="text-xs text-muted-foreground">צייד פרויקטים שנבנו עם Claude בתשלום — מודלים פרימיום, טוקנים וראיות השקעה</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              title={THRESHOLD_RULE_TEXT}
              className="hidden rounded-full border border-orange-300 bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 sm:inline-flex dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300"
            >
              🔒 סף מודלים: {THRESHOLD_LABEL} בלבד · 4.x חסום
            </span>
            <RateChip />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {/* כרטיס הדבקת טוקן — גלוי ובולט בראש העמוד */}
        <TokenBanner />

        {/* quick analyze */}
        <section className="mb-6 rounded-xl border bg-card p-4 shadow-sm" aria-label="ניתוח מאגר ספציפי">
          <p className="mb-2 text-sm font-semibold">🎯 נתח מאגר ספציפי מהר</p>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="github.com/owner/repo או owner/repo"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && quickAnalyze(quickInput)}
              dir="ltr"
              className="min-w-56 flex-1 font-mono text-sm"
              aria-label="כתובת מאגר לניתוח"
            />
            <Button onClick={() => quickAnalyze(quickInput)} disabled={!quickInput.trim()}>
              נתח עכשיו
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>נסה:</span>
            {QUICK_REPOS.map((r) => (
              <button
                key={r.fullName}
                onClick={() => {
                  setQuickInput(r.fullName);
                  quickAnalyze(r.fullName);
                }}
                className="rounded-full border px-2.5 py-1 font-mono transition-colors hover:border-orange-400 hover:text-orange-600"
              >
                {r.label}
              </button>
            ))}
          </div>
        </section>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKeyUnion)}>
          <TabsList className="mb-4 grid w-full max-w-4xl grid-cols-4 sm:grid-cols-7">
            <TabsTrigger value="search">🔍 חיפוש</TabsTrigger>
            <TabsTrigger value="watchlist">
              ⭐ נשמרים {(watchData?.items.length ?? 0) > 0 && <span className="mr-1 rounded-full bg-orange-100 px-1.5 text-xs text-orange-700">{watchData!.items.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="sweep">🛰️ סריקה</TabsTrigger>
            <TabsTrigger value="history">🕒 היסטוריה</TabsTrigger>
            <TabsTrigger value="genesis">🧬 Genesis</TabsTrigger>
            <TabsTrigger value="mission">🎯 מבצעים</TabsTrigger>
            <TabsTrigger value="live">⚔️ ציד חי</TabsTrigger>
          </TabsList>

          <TabsContent value="search" className="space-y-5">
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
                  בחרו מתכון מוכן, או בנו שאילתה: חיפוש מאגרים לפי נושא/כוכבים/תאריך, או חיפוש קוד
                  למחרוזות מודל פרימיום כמו <code dir="ltr" className="font-mono">claude-opus-5-5</code> או{" "}
                  <code dir="ltr" className="font-mono">claude-fable</code> — הראיה הישירה לכך שמישהו משלם על טוקנים.
                  <span className="mt-1 block text-xs font-medium text-orange-700 dark:text-orange-300">
                    🔒 הסף מחמיר ונעול: רק מודלים {THRESHOLD_LABEL} — משפחת 4.x נחסמת לחלוטין (ציון 0, סינון חסום בשרת).
                  </span>
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="watchlist">
            <WatchlistPanel onAnalyze={analyzeFromName} />
          </TabsContent>

          <TabsContent value="sweep">
            <SweepPanel />
          </TabsContent>

          <TabsContent value="history">
            <HistoryPanel
              onReRun={(body) => {
                setActiveTab("search");
                const merged = { ...SEARCH_DEFAULTS, ...body, page: 1 };
                setSearchBody(merged);
                runSearch(merged);
              }}
            />
          </TabsContent>

          <TabsContent value="genesis">
            <GenesisPanel />
          </TabsContent>

          <TabsContent value="mission">
            <MissionControlPanel />
          </TabsContent>

          <TabsContent value="live">
            <LiveHuntPanel />
          </TabsContent>
        </Tabs>
      </main>

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

      {/* footer */}
      <footer className="mt-auto border-t bg-muted/30 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Radar className="h-3.5 w-3.5" /> Claude Hunter — מדד ההשקעה הוא היוריסטיקה, לא עובדה מוחלטת
          </span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> השתמשו באחריות: כבדו רישיונות מאגרים ותנאי שימוש
            </span>
            <a href="https://github.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              <Github className="h-3.5 w-3.5" /> נתוני GitHub API
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
