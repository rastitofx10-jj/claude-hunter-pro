"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Star, GitFork, Users, HardDrive, GitCommitHorizontal, Eye,
  Zap, Lightbulb, FileCode2, Terminal, Bot, Server, TriangleAlert,
  ExternalLink, BookmarkPlus, Sparkles, Loader2,
} from "lucide-react";
import { apiFetch, parseRepoInputClient } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { ScoreBadge, TierChip } from "./score-badge";
import { RepoIntelSection } from "./ai-intel";
import type { AnalyzeResponse } from "@/lib/hunter-types";

const KIND_ICON: Record<string, React.ReactNode> = {
  "claude-md": <FileCode2 className="h-3.5 w-3.5" />,
  settings: <FileCode2 className="h-3.5 w-3.5" />,
  command: <Terminal className="h-3.5 w-3.5" />,
  agent: <Bot className="h-3.5 w-3.5" />,
  hook: <Zap className="h-3.5 w-3.5" />,
  "output-style": <Sparkles className="h-3.5 w-3.5" />,
  mcp: <Server className="h-3.5 w-3.5" />,
  "claude-dir": <FileCode2 className="h-3.5 w-3.5" />,
  "settings-local": <FileCode2 className="h-3.5 w-3.5" />,
};

export interface AnalyzeTarget {
  owner: string;
  repo: string;
}

export function AnalyzeSheet({
  target,
  onClose,
  onSaveRepo,
}: {
  target: AnalyzeTarget | null;
  onClose: () => void;
  onSaveRepo: (a: AnalyzeResponse) => void;
}) {
  const token = useHunterStore((s) => s.token);
  const enabled = !!target;

  const { data, isLoading, error } = useQuery({
    queryKey: ["analyze", target?.owner, target?.repo, !!token],
    queryFn: async () => {
      const res = await apiFetch<AnalyzeResponse>(
        `/api/analyze?owner=${encodeURIComponent(target!.owner)}&repo=${encodeURIComponent(target!.repo)}`,
        token
      );
      if (!res || typeof res.score?.total !== "number" || !res.repo) {
        throw new Error("Invalid server response — try again");
      }
      return res;
    },
    enabled,
    staleTime: 120_000,
  });

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-2xl p-0">
        <div className="p-6 space-y-5">
          <SheetHeader className="space-y-1 p-0 text-right">
            <SheetTitle className="flex items-center gap-2 text-lg">
              🔬 Deep Analysis
              {target && (
                <span dir="ltr" className="font-mono text-sm text-muted-foreground">
                  {target.owner}/{target.repo}
                </span>
              )}
            </SheetTitle>
            <SheetDescription>
              Scanning for evidence of paid Claude usage, premium models, and token investment
            </SheetDescription>
          </SheetHeader>

          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-24 w-full" />
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning the repo… (up to ~15 seconds)
              </p>
            </div>
          )}

          {!isLoading && (error || (data && !data.score)) && (
            <Alert variant="destructive">
              <TriangleAlert className="h-4 w-4" />
              <AlertTitle>Analysis Failed</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{(error as Error)?.message || "Invalid server response — try again"}</p>
                {!token && (
                  <p className="text-xs">
                    Tip: without a token you get a very low quota (60/hour). Add a free token with the button above.
                  </p>
                )}
                <a
                  href={`https://github.com/${target?.owner}/${target?.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs underline"
                >
                  Open manually on GitHub <ExternalLink className="h-3 w-3" />
                </a>
              </AlertDescription>
            </Alert>
          )}

          {data?.score && (
            <div className="space-y-5">
              {/* verdict — the strict model threshold */}
              {data.score.meetsModelThreshold ? (
                <Alert className="border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <Sparkles className="h-4 w-4" />
                  <AlertTitle className="text-sm">Meets the model threshold (5.5+)</AlertTitle>
                  <AlertDescription className="text-xs">
                    Flagship models at version 5.5 and above were detected — the project passes the strict criterion.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertTitle className="text-sm">⛔ Below threshold — 5.5+ required</AlertTitle>
                  <AlertDescription className="text-xs">
                    No model at version 5.5+ was detected (Opus 5.5, Fable, Opus 6+).
                    {data.models.some((m) => !m.qualifying)
                      ? " Only below-threshold models were found (the 4.x family and lower) — they are completely blocked and contribute nothing to the score."
                      : " The 4.x family is completely blocked in this tool."}
                  </AlertDescription>
                </Alert>
              )}

              {/* repo head */}
              <div className="flex items-start gap-3">
                <ScoreBadge score={data.score.total} tier={data.score.tier} size="lg" />
                <div className="min-w-0 flex-1 space-y-1">
                  <a href={data.repo.htmlUrl} target="_blank" rel="noreferrer" dir="ltr" className="block truncate text-lg font-bold hover:text-orange-600 hover:underline">
                    {data.repo.fullName}
                  </a>
                  <p className="text-sm text-muted-foreground" dir="auto">{data.repo.description || "No description"}</p>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <TierChip tier={data.score.tier} />
                    <Badge variant="outline" className="text-[10px]">
                      {data.repo.owner?.type === "User" ? "👤 Personal" : "🏢 Organization"}
                    </Badge>
                    {data.repo.license && <Badge variant="outline" className="text-[10px]">📄 {data.repo.license}</Badge>}
                  </div>
                </div>
              </div>

              {/* score breakdown */}
              <div className="rounded-xl border bg-card p-4 space-y-3">
                <p className="text-sm font-semibold">Token Investment Score — Breakdown</p>
                {[
                  { label: "Premium 5.5+ models (Opus 5.5/Fable…)", v: data.score.modelScore, max: 45 },
                  { label: "Payment & API evidence", v: data.score.paidScore, max: 30 },
                  { label: "Traction & community activity", v: data.score.tractionScore, max: 25 },
                  { label: "Cost/token mentions", v: data.score.usageScore, max: 15 },
                ].map((row) => (
                  <div key={row.label} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{row.label}</span>
                      <span className="font-mono">{row.v}/{row.max}</span>
                    </div>
                    <Progress value={(row.v / row.max) * 100} className="h-2" />
                  </div>
                ))}
              </div>

              {/* stats */}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[
                  { icon: <Star className="h-4 w-4 fill-amber-400 text-amber-400" />, v: (data.repo.stars ?? 0).toLocaleString(), l: "Stars" },
                  { icon: <GitFork className="h-4 w-4" />, v: (data.repo.forks ?? 0).toLocaleString(), l: "forks" },
                  { icon: <Users className="h-4 w-4" />, v: String(data.contributors), l: "Contributors" },
                  { icon: <HardDrive className="h-4 w-4" />, v: `${Math.round((data.repo.size ?? 0) / 1024)}KB`, l: "Size" },
                  { icon: <Eye className="h-4 w-4" />, v: String(data.repo.watchers ?? "?"), l: "Watchers" },
                  { icon: <GitCommitHorizontal className="h-4 w-4" />, v: data.repo.pushedAt ? new Date(data.repo.pushedAt).toLocaleDateString("en-US") : "?", l: "Last push" },
                ].map((s, i) => (
                  <div key={i} className="rounded-lg border bg-muted/40 p-2 text-center">
                    <div className="flex justify-center">{s.icon}</div>
                    <div className="mt-1 truncate text-sm font-semibold" dir="ltr">{s.v}</div>
                    <div className="text-[10px] text-muted-foreground">{s.l}</div>
                  </div>
                ))}
              </div>

              {/* models */}
              {data.models.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">🧠 Models Detected in Code</p>
                  <div className="space-y-1.5">
                    {data.models.map((m) => (
                      <div
                        key={m.id}
                        className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
                          m.qualifying ? "border-orange-200 bg-orange-50/50 dark:border-orange-900 dark:bg-orange-950/20" : "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20"
                        }`}
                      >
                        <span className={`font-medium ${m.qualifying ? "" : "text-red-700 line-through dark:text-red-300"}`} dir="ltr">
                          {m.label}
                        </span>
                        {m.qualifying ? (
                          <Badge className="bg-orange-100 text-[10px] text-orange-800 hover:bg-orange-100 dark:bg-orange-900 dark:text-orange-200">✅ 5.5+ · weight {m.weight}</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">⛔ Blocked (below 5.5) · weight 0</Badge>
                        )}
                        {m.hits != null && <Badge variant="outline" className="text-[10px]">{m.hits} files</Badge>}
                        <span className="text-xs text-muted-foreground">Sources: {m.sources.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* evidence */}
              {data.evidence.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">🔎 Paid Usage Evidence</p>
                  <div className="space-y-1.5">
                    {data.evidence.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                        <span className="flex-1">{e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:underline">{e.label}</a> : e.label}</span>
                        <Badge variant="secondary" className="text-[10px]">+{e.weight}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* insights */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                  <Lightbulb className="h-4 w-4" /> What can we take from here for our interface?
                </p>
                <ul className="mt-2 space-y-1.5">
                  {data.insights.map((ins, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-sm text-emerald-900 dark:text-emerald-200">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                      {ins}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 🧠 AI intelligence report — closes the loop from discovery to decision */}
              <RepoIntelSection analysis={data} />

              {/* claude files */}
              {data.claudeFiles.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">📁 Claude Files ({data.claudeFiles.length})</p>
                  {data.commands.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {data.commands.map((c) => (
                        <Badge key={c} variant="secondary" dir="ltr" className="font-mono text-[10px]">/{c}</Badge>
                      ))}
                    </div>
                  )}
                  {data.agents.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {data.agents.map((a) => (
                        <Badge key={a} variant="outline" dir="ltr" className="font-mono text-[10px]">🤖 {a}</Badge>
                      ))}
                    </div>
                  )}
                  <ScrollArea className="h-40 rounded-lg border">
                    <div className="p-2" dir="ltr">
                      {data.claudeFiles.map((f) => (
                        <a key={f.path} href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded px-1.5 py-1 font-mono text-xs hover:bg-muted hover:text-orange-600">
                          {KIND_ICON[f.kind] ?? <FileCode2 className="h-3.5 w-3.5" />}
                          <span className="truncate">{f.path}</span>
                        </a>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* languages */}
              {data.languages.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">💻 Languages</p>
                  {data.languages.map((l) => (
                    <div key={l.name} className="space-y-1">
                      <div className="flex justify-between text-xs" dir="ltr">
                        <span className="font-mono">{l.name}</span>
                        <span>{l.pct}%</span>
                      </div>
                      <Progress value={l.pct} className="h-1.5" />
                    </div>
                  ))}
                </div>
              )}

              {/* mentions */}
              {(data.mentions.prices.length > 0 || data.mentions.tokens.length > 0) && (
                <div className="space-y-1.5 rounded-xl border bg-card p-4">
                  <p className="text-sm font-semibold">💰 Cost/Token Mentions</p>
                  <div className="flex flex-wrap gap-1.5" dir="ltr">
                    {[...data.mentions.prices, ...data.mentions.tokens].map((m, i) => (
                      <span key={i} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{m}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* readme */}
              {data.readmeExcerpt && (
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold">📖 README Excerpt</p>
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed" dir="ltr">
                    {data.readmeExcerpt}
                  </pre>
                </div>
              )}

              {/* warnings */}
              {data.warnings.map((w, i) => (
                <Alert key={i} className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertDescription className="text-xs">{w}</AlertDescription>
                </Alert>
              ))}

              {/* actions */}
              <div className="flex gap-2">
                <Button onClick={() => onSaveRepo(data)} className="flex-1 gap-1.5">
                  <BookmarkPlus className="h-4 w-4" /> Save to list
                </Button>
                <Button variant="outline" asChild>
                  <a href={data.repo.htmlUrl} target="_blank" rel="noreferrer" className="gap-1.5">
                    <ExternalLink className="h-4 w-4" /> GitHub
                  </a>
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { parseRepoInputClient };
