"use client";

import { ChevronRight, ChevronLeft, FileJson, FileSpreadsheet, Loader2, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RepoCard } from "./repo-card";
import { downloadFile, toCsv } from "@/lib/api-client";
import type { ScoredRepo } from "@/lib/hunter-types";

export function ResultsSection({
  items,
  totalMatches,
  repoCount,
  mode,
  querySent,
  page,
  perPage,
  canPaginate,
  blockedHidden,
  loading,
  onPage,
  onAnalyze,
  onSave,
  savedNames,
}: {
  items: ScoredRepo[];
  totalMatches: number;
  repoCount?: number;
  mode: "repos" | "code";
  querySent: string;
  page: number;
  perPage: number;
  /** false = no real pagination (code mode) — no fake pagination buttons are shown */
  canPaginate?: boolean;
  blockedHidden?: number;
  loading: boolean;
  onPage: (p: number) => void;
  onAnalyze: (fullName: string) => void;
  onSave: (item: ScoredRepo) => void;
  savedNames: Set<string>;
}) {
  const exportJson = () =>
    downloadFile(
      `claude-hunter-${Date.now()}.json`,
      JSON.stringify({ querySent, mode, totalMatches, exportedAt: new Date().toISOString(), items }, null, 2),
      "application/json"
    );
  const exportCsv = () =>
    downloadFile(
      `claude-hunter-${Date.now()}.csv`,
      toCsv(
        items.map((i) => ({
          fullName: i.fullName,
          score: i.score,
          stars: i.stars,
          forks: i.forks,
          language: i.language ?? "",
          ownerType: i.owner?.type ?? "",
          pushedAt: i.pushedAt ?? "",
          description: i.description ?? "",
          url: i.htmlUrl,
        }))
      ),
      "text/csv;charset=utf-8"
    );

  return (
    <section className="space-y-3" aria-label="Search results">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{totalMatches.toLocaleString()}</span> results
          {mode === "code" && repoCount != null && <> · grouped into <span className="font-semibold text-foreground">{repoCount}</span> repos</>}
          <span dir="ltr" className="mx-2 hidden font-mono text-xs sm:inline">q={querySent}</span>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={exportJson} disabled={items.length === 0} className="gap-1.5 text-xs">
            <FileJson className="h-3.5 w-3.5" /> JSON
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={items.length === 0} className="gap-1.5 text-xs">
            <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
          </Button>
        </div>
      </div>

      {/* ⛔ Blocking transparency: repos with only 4.x models were hidden completely */}
      {(blockedHidden ?? 0) > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <ShieldX className="h-4 w-4 shrink-0" />
          <span>
            <strong>{blockedHidden}</strong> repos were hidden entirely — only models below the 5.5 threshold were detected in them (the 4.x family is blocked).
          </span>
        </div>
      )}

      <div className={`grid gap-3 md:grid-cols-2 xl:grid-cols-3 ${loading ? "opacity-50" : ""}`}>
        {items.map((item) => (
          <RepoCard
            key={item.fullName}
            item={item}
            onAnalyze={() => onAnalyze(item.fullName)}
            onSave={() => onSave(item)}
            saved={savedNames.has(item.fullName)}
          />
        ))}
      </div>

      {canPaginate !== false && totalMatches > perPage && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} className="gap-1">
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || page * perPage >= totalMatches}
            onClick={() => onPage(page + 1)}
            className="gap-1"
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      )}
    </section>
  );
}
