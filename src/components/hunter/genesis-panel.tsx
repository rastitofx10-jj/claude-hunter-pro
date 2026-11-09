"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dna,
  Hammer,
  Download,
  Sparkles,
  Trash2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Zap,
  Loader2,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { apiFetch, downloadFile } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import type { WatchItem } from "@/lib/hunter-types";

// ---------- types ----------

interface DnaArtifactRow {
  id: number;
  sourceRepo: string;
  path: string;
  kind: string;
  name: string;
  description?: string | null;
  content?: string | null;
  contentPreview?: string;
  hasContent?: boolean;
  rawUrl?: string | null;
  size: number;
}

interface ChimeraWorkOrder {
  title: string;
  spec: string;
  claudePrompt: string;
  effort: string;
}

interface ChimeraResponse {
  id?: number;
  chimeraName: string;
  oneLiner: string;
  skillMd: string;
  principles: string[];
  workOrders: ChimeraWorkOrder[];
  breakthrough: string;
  sources: string[];
  generatedAt: string;
}

interface HarvestReport {
  repo: string;
  stars: number;
  artifacts: number;
  kinds: string[];
  newCount: number;
}
interface HarvestResult {
  candidatesFound: number;
  reposMined: HarvestReport[];
  artifactsAdded: number;
  totalLibrary: number;
  fieldDna: number;
  skippedAlreadyMined: number;
  /** Round 5 — full transparency: what happened in discovery and what failed */
  queriesRun?: { q: string; count: number }[];
  queriesFailed?: { q: string; error: string }[];
  reposFailed?: { repo: string; error: string }[];
}

const KIND_META: Record<string, { label: string; emoji: string; color: string }> = {
  skill: { label: "Skill", emoji: "🧩", color: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  command: { label: "Command", emoji: "⌨️", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  agent: { label: "Agent", emoji: "🤖", color: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  "claude-md": { label: "CLAUDE.md", emoji: "📘", color: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  "agents-md": { label: "AGENTS.md", emoji: "📗", color: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300" },
  "mcp-config": { label: "MCP", emoji: "🔌", color: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" },
};

export function GenesisPanel() {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const [mineInput, setMineInput] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Full content is loaded on demand only (the list stays light — 40KB instead of 692KB)
  const [fullContents, setFullContents] = useState<Map<number, string>>(new Map());
  const [loadingContent, setLoadingContent] = useState<Set<number>>(new Set());
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [productContext, setProductContext] = useState("");
  const [chimera, setChimera] = useState<ChimeraResponse | null>(null);
  const [harvestResult, setHarvestResult] = useState<HarvestResult | null>(null);
  // Live harvest timer — feedback that the pipeline is alive (before: a mute spinner for a minute that looked stuck)
  const [harvestElapsed, setHarvestElapsed] = useState(0);

  // ---------- queries ----------
  const { data: lib, isLoading: libLoading } = useQuery({
    queryKey: ["dna-library"],
    queryFn: () => apiFetch<{ items: DnaArtifactRow[] }>("/api/dna-library", token),
  });

  const { data: chimeraHistory } = useQuery({
    queryKey: ["chimeras"],
    queryFn: () => apiFetch<{ items: ChimeraResponse[] }>("/api/genesis/chimeras", token),
  });

  const { data: watch } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiFetch<{ items: WatchItem[] }>("/api/watchlist", token),
    staleTime: 60_000,
  });

  const grouped = useMemo(() => {
    const map = new Map<string, DnaArtifactRow[]>();
    for (const a of lib?.items ?? []) {
      const arr = map.get(a.sourceRepo) ?? [];
      arr.push(a);
      map.set(a.sourceRepo, arr);
    }
    return map;
  }, [lib]);

  const quickTargets = useMemo(() => {
    const fromWatch = (watch?.items ?? []).map((w) => w.fullName);
    return Array.from(new Set([...fromWatch])).slice(0, 6);
  }, [watch]);

  // ---------- mutations ----------
  const mine = useMutation({
    mutationFn: (fullName: string) =>
      apiFetch<{ repo: string; artifacts: DnaArtifactRow[]; note?: string }>("/api/genesis/mine", token, {
        method: "POST",
        body: JSON.stringify({ fullName }),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["dna-library"] });
      setSelectedRepos((s) => new Set([...s, data.repo]));
      if (data.note) {
        toast({ title: "No DNA found", description: data.note });
      } else {
        toast({ title: `DNA mined! 🧬`, description: `${data.repo}: ${data.artifacts.length} artifacts saved to the library` });
      }
    },
    onError: (e: Error) => toast({ title: "Mining failed", description: e.message, variant: "destructive" }),
  });

  const synthesize = useMutation({
    mutationFn: () =>
      apiFetch<ChimeraResponse>("/api/genesis/synthesize", token, {
        method: "POST",
        body: JSON.stringify({ repos: Array.from(selectedRepos), productContext }),
      }),
    onSuccess: (data) => {
      setChimera(data);
      void qc.invalidateQueries({ queryKey: ["chimeras"] });
      toast({ title: "Chimera created! 🧬⚡", description: data.chimeraName });
    },
    onError: (e: Error) => toast({ title: "Chimera creation failed", description: e.message, variant: "destructive" }),
  });

  const clearRepo = useMutation({
    // ?all=1 is explicit for deleting everything — a delete without params used to mean "all", and an empty ?repo= leaked into it
    mutationFn: (repo: string | null) =>
      apiFetch(
        `/api/dna-library${repo ? `?repo=${encodeURIComponent(repo)}` : "?all=1"}`,
        token,
        { method: "DELETE" }
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dna-library"] }),
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ---------- autonomous harvest ----------
  const harvest = useMutation({
    mutationFn: () =>
      apiFetch<HarvestResult>("/api/harvest", token, {
        method: "POST",
        body: JSON.stringify({ maxRepos: 6 }),
      }),
    onSuccess: (data) => {
      setHarvestResult(data);
      void qc.invalidateQueries({ queryKey: ["dna-library"] });
      void qc.invalidateQueries({ queryKey: ["missions"] });
      toast({
        title: data.artifactsAdded > 0 ? `Harvest complete! ⚡🧬 +${data.artifactsAdded} genes` : "Harvest finished",
        description: `${data.reposMined.length} repos mined · library: ${data.totalLibrary} genes`,
      });
    },
    onError: (e: Error) => toast({ title: "Harvest failed", description: e.message, variant: "destructive" }),
  });

  // Live timer during harvest — defined after the mutation (avoids TDZ) · feedback that the pipeline is alive
  useEffect(() => {
    if (!harvest.isPending) {
      setHarvestElapsed(0);
      return;
    }
    setHarvestElapsed(0);
    const t0 = Date.now();
    const iv = setInterval(() => setHarvestElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [harvest.isPending]);

  const exportCodex = async () => {
    try {
      const data = await apiFetch<{ filename: string; content: string; stats: { artifacts: number; sources: number } }>(
        "/api/export/pack",
        token
      );
      downloadFile(data.filename, data.content, "text/markdown");
      toast({ title: "Codex downloading 📦", description: `${data.stats.artifacts} genes from ${data.stats.sources} sources` });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  // ---------- helpers ----------
  const parseInput = (raw: string): string | null => {
    let s = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^github\.com\//i, "");
    s = s.split(/[?#]/)[0].replace(/\/+$/, "");
    const parts = s.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
    return `${parts[0]}/${parts[1]}`;
  };

  const ensureFullContent = async (id: number) => {
    if (fullContents.has(id) || loadingContent.has(id)) return;
    setLoadingContent((s) => new Set(s).add(id));
    try {
      const row = await apiFetch<DnaArtifactRow>(`/api/dna-library/${id}`, token);
      setFullContents((m) => new Map(m).set(id, row.content ?? ""));
    } catch {
      toast({ title: "Failed to load content", variant: "destructive" });
    } finally {
      setLoadingContent((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const toggleExpand = (id: number) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        void ensureFullContent(id);
      }
      return n;
    });
  };

  const toggleRepo = (repo: string) => {
    setSelectedRepos((s) => {
      const n = new Set(s);
      if (n.has(repo)) n.delete(repo);
      else n.add(repo);
      return n;
    });
  };

  const exportSkillMd = () => {
    if (!chimera) return;
    downloadFile(`SKILL.md`, chimera.skillMd, "text/markdown");
  };

  const exportBundle = () => {
    if (!chimera) return;
    const bundle = [
      `# 🧬 Genesis Inject Bundle — ${chimera.chimeraName}`,
      `> Sources: ${chimera.sources.join(", ")} · ${new Date(chimera.generatedAt).toLocaleString("en-US")}`,
      ``,
      `## Installation`,
      `Copy the following file to: \`.claude/skills/${chimera.chimeraName}/SKILL.md\``,
      ``,
      `## SKILL.md`,
      ``,
      chimera.skillMd,
      ``,
      chimera.principles.length ? `## Principles\n\n${chimera.principles.map((p) => `- ${p}`).join("\n")}` : "",
      ``,
      chimera.workOrders.length
        ? `## Work Orders\n\n${chimera.workOrders
            .map((w, i) => `### ${i + 1}. ${w.title} (${w.effort})\n${w.spec}\n\nClaude Code prompt:\n\n${w.claudePrompt}`)
            .join("\n\n---\n\n")}`
        : "",
      ``,
      chimera.breakthrough ? `## 🚀 The Next Breakthrough\n\n${chimera.breakthrough}` : "",
    ].join("\n");
    downloadFile(`genesis-${chimera.chimeraName}.md`, bundle, "text/markdown");
  };

  return (
    <div className="space-y-6">
      {/* hero */}
      <section className="rounded-xl border border-violet-300/60 bg-gradient-to-l from-violet-50 via-fuchsia-50/50 to-background p-5 shadow-sm dark:border-violet-800 dark:from-violet-950/30 dark:via-fuchsia-950/10">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-md">
            <Dna className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <h2 className="text-lg font-bold">🧬 Genesis — The Superiority Engine</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Mines the real capability files (<code dir="ltr" className="font-mono text-xs">.claude/skills</code>, commands, agents, CLAUDE.md) from the elite repos it identifies,
              stores them in the DNA library, and fuses them with AI into <strong>one superior chimera</strong> + work orders ready to run on our product.
              This is the loop that turns intelligence into power: <strong>Mine → Merge → Inject → Win</strong>.
            </p>
          </div>
        </div>
      </section>

      {/* mine */}
      <section className="rounded-xl border bg-card p-4 shadow-sm" aria-label="DNA mining">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Hammer className="h-4 w-4" /> Mine DNA from a repo
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="github.com/owner/repo or owner/repo"
            value={mineInput}
            onChange={(e) => setMineInput(e.target.value)}
            onKeyDown={(e) => {
              const full = parseInput(mineInput);
              if (e.key === "Enter" && full) mine.mutate(full);
            }}
            dir="ltr"
            className="min-w-56 flex-1 font-mono text-sm"
            aria-label="Repo URL to mine"
          />
          <Button
            onClick={() => {
              const full = parseInput(mineInput);
              if (!full) {
                toast({ title: "Invalid URL", description: "Paste github.com/owner/repo", variant: "destructive" });
                return;
              }
              mine.mutate(full);
            }}
            disabled={mine.isPending || !mineInput.trim()}
            className="gap-1.5 bg-gradient-to-l from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
          >
            {mine.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dna className="h-4 w-4" />}
            Mine now
          </Button>
        </div>
        {quickTargets.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>From watchlist:</span>
            {quickTargets.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setMineInput(r);
                  mine.mutate(r);
                }}
                disabled={mine.isPending}
                className="rounded-full border px-2.5 py-1 font-mono transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-50"
              >
                {r}
              </button>
            ))}
          </div>
        )}

        {/* autonomous harvest */}
        <div className="mt-3 rounded-lg border border-amber-300/70 bg-gradient-to-l from-amber-50 via-orange-50/60 to-background p-3 dark:border-amber-800 dark:from-amber-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="flex items-center gap-1.5 text-sm font-bold text-amber-700 dark:text-amber-300">
                <Zap className="h-4 w-4" /> Autonomous harvest — one click and the library explodes
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The engine discovers elite repos on its own from 5.5+ code searches (opus-5-5 · fable · opus-6 · 6-5 · 7), ranks them by skill richness, and mines the 6 richest
              </p>
            </div>
            <Button
              onClick={() => harvest.mutate()}
              disabled={harvest.isPending}
              className="shrink-0 bg-gradient-to-l from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
            >
              {harvest.isPending ? (
                <>
                  <Loader2 className="ml-1.5 h-4 w-4 animate-spin" /> Harvesting the elite… <span className="tabular-nums opacity-80">{harvestElapsed}s</span>
                </>
              ) : (
                <>
                  <Zap className="ml-1.5 h-4 w-4" /> Run autonomous harvest
                </>
              )}
            </Button>
          </div>
          {harvestResult && (
            <div className="mt-3 rounded-md border bg-background p-3 text-xs">
              <p className="font-bold text-amber-700 dark:text-amber-300">
                {harvestResult.candidatesFound} elite repos discovered · {harvestResult.reposMined.length} mined · +{harvestResult.artifactsAdded} new genes · {harvestResult.totalLibrary} total in library
              </p>
              <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                {harvestResult.reposMined.map((r) => (
                  <li key={r.repo} className="flex flex-wrap items-center gap-1.5">
                    <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" dir="ltr" className="font-mono font-semibold text-violet-600 hover:underline dark:text-violet-400">
                      {r.repo}
                    </a>
                    <span className="text-muted-foreground">⭐{r.stars.toLocaleString()}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-400">+{r.newCount}</Badge>
                    <span className="text-muted-foreground">({r.kinds.join(", ")})</span>
                  </li>
                ))}
              </ul>
              {/* Full transparency — previously vanished silently (round 5) */}
              {(harvestResult.reposFailed?.length ?? 0) > 0 && (
                <div className="mt-2 rounded border border-red-200 bg-red-50/50 p-2 dark:border-red-900 dark:bg-red-950/30">
                  <p className="font-semibold text-red-700 dark:text-red-300">Failed mining ({harvestResult.reposFailed?.length}):</p>
                  <ul className="mt-1 space-y-0.5">
                    {harvestResult.reposFailed?.map((f) => (
                      <li key={f.repo} className="font-mono text-[11px] text-red-700 dark:text-red-300" dir="ltr">
                        {f.repo} — <span className="font-sans">{f.error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(harvestResult.queriesFailed?.length ?? 0) > 0 && (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50/50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="font-semibold text-amber-700 dark:text-amber-300">Failed discovery queries ({harvestResult.queriesFailed?.length}):</p>
                  <ul className="mt-1 space-y-0.5">
                    {harvestResult.queriesFailed?.map((f) => (
                      <li key={f.q} className="text-[11px] text-amber-800 dark:text-amber-300">
                        <code dir="ltr" className="font-mono">{f.q}</code> — {f.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* DNA library */}
      <section className="rounded-xl border bg-card p-4 shadow-sm" aria-label="DNA library">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <BookOpen className="h-4 w-4" /> DNA Library
            <Badge variant="secondary" className="font-mono">{lib?.items.length ?? 0}</Badge>
          </p>
          {(lib?.items.length ?? 0) > 0 && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300"
                onClick={() => void exportCodex()}
                title="Download the whole library as one injection-ready codex"
              >
                <Download className="h-3.5 w-3.5" /> Export DNA codex
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={() => {
                  // Confirmation required — deleting the whole library in one click with no confirmation was a data disaster waiting to happen
                  if (!window.confirm("Delete the entire DNA library? Every gene from every repo will be permanently deleted.")) return;
                  clearRepo.mutate(null);
                  setSelectedRepos(new Set());
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear all
              </Button>
            </div>
          )}
        </div>

        {libLoading && <div className="h-24 animate-pulse rounded-lg bg-muted/40" />}

        {!libLoading && grouped.size === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p className="text-3xl">🧬</p>
            <p className="mt-2 font-medium">The library is empty</p>
            <p className="mt-1">Mine an elite repo (e.g. storytold/craft-anything) and its genes will land here</p>
          </div>
        )}

        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([repo, artifacts]) => (
            <div key={repo} className="rounded-lg border bg-muted/20 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={selectedRepos.has(repo)}
                    onChange={() => toggleRepo(repo)}
                    className="h-4 w-4 accent-violet-600"
                    aria-label={`Select ${repo} for the chimera`}
                  />
                  <span className="font-mono">{repo}</span>
                  <Badge variant="secondary" className="text-[10px]">{artifacts.length} genes</Badge>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs text-muted-foreground"
                  onClick={() => clearRepo.mutate(repo)}
                >
                  <Trash2 className="h-3 w-3" /> Remove repo
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {artifacts.map((a) => {
                  const meta = KIND_META[a.kind] ?? { label: a.kind, emoji: "📄", color: "bg-muted text-foreground" };
                  const isOpen = expanded.has(a.id);
                  return (
                    <div key={a.id} className="rounded-md border bg-background p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <span>{meta.emoji}</span>
                            <span className="truncate" dir="ltr">{a.name}</span>
                          </p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" dir="ltr" title={a.path}>
                            {a.path}
                          </p>
                        </div>
                        <button onClick={() => toggleExpand(a.id)} className="shrink-0 rounded p-1 hover:bg-muted" aria-label={isOpen ? "Hide content" : "Show content"}>
                          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                      </div>
                      <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.color}`}>
                        {meta.label}
                      </span>
                      {a.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.description}</p>}
                      {isOpen && (
                        <pre
                          dir="ltr"
                          className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2.5 font-mono text-[10px] leading-relaxed text-emerald-100"
                        >
                          {loadingContent.has(a.id)
                            ? "Loading full content…"
                            : (fullContents.get(a.id) ?? a.contentPreview ?? a.content ?? "No saved content").slice(0, 4000)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* chimera forge */}
      <section className="rounded-xl border-2 border-violet-400/60 bg-gradient-to-b from-violet-50/60 to-background p-4 shadow-sm dark:border-violet-700 dark:from-violet-950/20" aria-label="Chimera operation">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-bold">
          <FlaskConical className="h-4 w-4 text-violet-600" /> The chimera operation — merge the best of all of them
        </p>
        <p className="mb-3 text-xs text-muted-foreground">
          Select source repos from the library ({selectedRepos.size} selected) → the AI fuses their DNA into one superior skill + work orders for our product.
        </p>

        {grouped.size > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {Array.from(grouped.keys()).map((repo) => (
              <button
                key={repo}
                onClick={() => toggleRepo(repo)}
                className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                  selectedRepos.has(repo)
                    ? "border-violet-500 bg-violet-600 text-white"
                    : "border-muted hover:border-violet-400"
                }`}
                aria-pressed={selectedRepos.has(repo)}
              >
                {repo}
              </button>
            ))}
          </div>
        )}

        <textarea
          value={productContext}
          onChange={(e) => setProductContext(e.target.value)}
          placeholder="Our product context (optional) — e.g.: we're building an AI data-analysis interface, Next.js + Prisma…"
          className="mb-3 min-h-16 w-full rounded-md border bg-background p-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-400"
          aria-label="Product context for the chimera"
        />

        <Button
          onClick={() => synthesize.mutate()}
          disabled={synthesize.isPending || selectedRepos.size === 0}
          className="w-full gap-2 bg-gradient-to-l from-violet-600 to-fuchsia-600 py-5 text-base text-white shadow-md hover:from-violet-700 hover:to-fuchsia-700 disabled:opacity-50"
          size="lg"
        >
          {synthesize.isPending ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" /> Fusing genes… (up to a minute)
            </>
          ) : (
            <>
              <Sparkles className="h-5 w-5" /> Create chimera from {selectedRepos.size} repos
            </>
          )}
        </Button>

        {/* chimera result */}
        {chimera && (
          <div className="mt-5 space-y-4 rounded-xl border border-violet-300 bg-card p-4 shadow-md dark:border-violet-800">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold">
                  <Zap className="h-5 w-5 text-violet-600" />
                  <span dir="ltr" className="font-mono">{chimera.chimeraName}</span>
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{chimera.oneLiner}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={exportSkillMd}>
                  <Download className="h-3.5 w-3.5" /> SKILL.md
                </Button>
                <Button size="sm" className="gap-1.5 bg-violet-600 text-white hover:bg-violet-700" onClick={exportBundle}>
                  <Download className="h-3.5 w-3.5" /> Full injection bundle
                </Button>
              </div>
            </div>

            {chimera.principles.length > 0 && (
              <div>
                <p className="mb-1.5 text-sm font-semibold">🧭 Extracted Principles</p>
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {chimera.principles.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}

            <div>
              <p className="mb-1.5 text-sm font-semibold">📜 SKILL.md — ready to inject into .claude/skills/{chimera.chimeraName}/</p>
              <pre dir="ltr" className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-100">
                {chimera.skillMd}
              </pre>
            </div>

            {chimera.workOrders.length > 0 && (
              <div>
                <p className="mb-1.5 text-sm font-semibold">🔨 Work Orders — ready to paste into Claude Code</p>
                <div className="grid gap-2">
                  {chimera.workOrders.map((w, i) => (
                    <div key={i} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{i + 1}. {w.title}</p>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">⏱ {w.effort}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{w.spec}</p>
                      {w.claudePrompt && (
                        <pre dir="ltr" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono text-[10px]">
                          {w.claudePrompt}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {chimera.breakthrough && (
              <div className="rounded-lg border-2 border-amber-400/60 bg-amber-50/60 p-3 dark:border-amber-700 dark:bg-amber-950/30">
                <p className="text-sm font-bold text-amber-700 dark:text-amber-300">🚀 The Next Breakthrough</p>
                <p className="mt-1 text-sm leading-relaxed">{chimera.breakthrough}</p>
              </div>
            )}
          </div>
        )}

        {/* chimera history */}
        {(chimeraHistory?.items.length ?? 0) > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Past chimeras:</p>
            <div className="flex flex-wrap gap-1.5">
              {chimeraHistory!.items.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChimera(c)}
                  className="rounded-full border px-2.5 py-1 font-mono text-xs transition-colors hover:border-violet-400 hover:text-violet-600"
                >
                  {c.chimeraName}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
