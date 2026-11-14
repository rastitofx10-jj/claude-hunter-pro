"use client";

// ============================================================
// The Reflexion tab — the hunter's inward loop, made visible.
//
// This panel shows the engine that analyzes the platform's OWN
// telemetry (query yields, mission outcomes, library growth,
// sweep/hunt stats) through the LLM — with truth gates:
//   * every finding must cite evidence that appears verbatim in
//     the telemetry digest (machine-verified), otherwise it is
//     REJECTED and the rejection is displayed here, openly;
//   * every proposed query is validated, deduped and measured in
//     the field by adaptive learning — sterile ones are evicted.
//
// The tab is intentionally honest: it shows what was refused, not
// only what passed. Trust comes from visible refusals.
// ============================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Dna,
  Loader2,
  Play,
  Quote,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { toast } from "@/hooks/use-toast";

// ---------- types (mirror of GET /api/reflexion) ----------

interface ReflexionFindingRejected { title: string; reason: string }
interface ReflexionQueryRejected { q: string; reason: string }

interface ReflexionRun {
  at: string;
  method: "ai" | "skipped-empty" | "error";
  analysis?: string;
  findingsKept: number;
  findingsRejected: ReflexionFindingRejected[];
  queriesAccepted: { q: string; why: string }[];
  queriesRejected: ReflexionQueryRejected[];
  dnaBornId: number | null;
  note?: string;
}

interface ReflexionPoolEntry { q: string; why: string; bornAt: string }

interface ReflexionResponse {
  history: ReflexionRun[];
  pool: ReflexionPoolEntry[];
  telemetry: {
    libraryTotal: number;
    bornLast7d: number;
    missionsTotal: number;
    sweepsTotal: number;
    huntsTotal: number;
    trackedQueries: number;
    sterileQueries: number;
  };
  lastRunAt: string | null;
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

// ---------- component ----------

export function ReflexionPanel() {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const hydrated = useHydrated();
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["reflexion"],
    queryFn: () => apiFetch<ReflexionResponse>("/api/reflexion", token),
    enabled: hydrated,
  });

  const runNow = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; run: ReflexionRun }>("/api/reflexion", token, { method: "POST" }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["reflexion"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      void qc.invalidateQueries({ queryKey: ["dna-library"] });
      const r = res.run;
      if (r.method === "skipped-empty") {
        toast({ title: "Nothing to reflect on yet", description: r.note ?? "Run a hunt first — reflexion needs measured telemetry." });
      } else {
        toast({
          title: `Reflexion complete — ${r.findingsKept} verified findings`,
          description: `${r.queriesAccepted.length} query mutation(s) accepted · ${r.findingsRejected.length} invention attempt(s) refused`,
        });
      }
    },
    onError: (e: Error) => toast({ title: "Reflexion failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
        ))}
      </div>
    );
  }

  const t = data?.telemetry;
  const history = data?.history ?? [];
  const pool = data?.pool ?? [];

  return (
    <div className="space-y-5">
      {/* ---------- header card ---------- */}
      <Card className="border-orange-200/60 bg-gradient-to-br from-orange-50/60 via-card to-card dark:border-orange-900/40 dark:from-orange-950/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BrainCircuit className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden />
            Reflexion — the hunter analyzing itself
            <Badge variant="outline" className="ml-auto gap-1 border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
              <ShieldCheck className="h-3 w-3" aria-hidden /> truth-gated
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            The platform&apos;s own telemetry — query yields, mission outcomes, library growth, sweep and hunt stats — is
            analyzed by the LLM with <strong className="text-foreground">mandatory evidence citations</strong>. Findings
            without verifiable evidence are refused and reported. Validated lessons are born as
            <span className="mx-1 inline-flex items-center gap-1 font-medium text-orange-700 dark:text-orange-300">
              <Dna className="h-3.5 w-3.5" aria-hidden /> self-DNA
            </span>
            and proposed queries enter the live hunt pool, where the field itself decides if they survive.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "Library genes", value: t?.libraryTotal ?? 0 },
              { label: "Born 7d", value: t?.bornLast7d ?? 0 },
              { label: "Missions", value: t?.missionsTotal ?? 0 },
              { label: "Hunts", value: t?.huntsTotal ?? 0 },
              { label: "Tracked queries", value: t?.trackedQueries ?? 0 },
              { label: "Sterile queries", value: t?.sterileQueries ?? 0 },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border bg-background/60 p-2 text-center">
                <div className="text-lg font-bold tabular-nums">{s.value.toLocaleString()}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => runNow.mutate()} disabled={runNow.isPending} className="gap-2">
              {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {runNow.isPending ? "Analyzing own telemetry…" : "Run reflexion now"}
            </Button>
            <span className="text-xs text-muted-foreground">
              last run: {relative(data?.lastRunAt)} · runs automatically at the end of every autonomous daily cycle
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ---------- live query pool ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4.5 w-4.5 text-amber-500" aria-hidden />
            Evolved query pool
            <Badge variant="secondary" className="ml-auto">{pool.length}/8 live</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pool.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No evolved queries yet. After a reflexion run with validated proposals, they appear here — and the
              harvest immediately starts probing the new coordinates.
            </p>
          ) : (
            <ul className="space-y-2">
              {pool.map((p, i) => (
                <li key={`${p.q}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2">
                  <code dir="ltr" className="font-mono text-xs font-semibold text-orange-700 dark:text-orange-300">{p.q}</code>
                  <span className="text-xs text-muted-foreground">{p.why}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">born {relative(p.bornAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Selection pressure: a pool query that runs {3}+ times yielding under the floor is evicted automatically —
            the reflexion&apos;s own proposals face the same field trial as every other query in the arsenal.
          </p>
        </CardContent>
      </Card>

      {/* ---------- run history ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Quote className="h-4.5 w-4.5 text-orange-600 dark:text-orange-300" aria-hidden />
            Run history — what passed, and what was refused
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {history.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No reflexion runs recorded yet. The engine will run after the next autonomous cycle, or press
              &quot;Run reflexion now&quot; above.
            </p>
          ) : (
            <ul className="space-y-3">
              {history.map((run, idx) => {
                const open = expanded === idx;
                const hasRejections = run.findingsRejected.length + run.queriesRejected.length > 0;
                return (
                  <li key={run.at} className="rounded-xl border bg-muted/20">
                    <button
                      className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-start"
                      onClick={() => setExpanded(open ? null : idx)}
                      aria-expanded={open}
                    >
                      <Badge variant={run.method === "ai" ? "default" : "secondary"} className="font-mono text-[10px] uppercase">
                        {run.method}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{relative(run.at)}</span>
                      <span className="ml-auto flex items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {run.findingsKept} verified
                        </span>
                        {hasRejections && (
                          <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                            <XCircle className="h-3.5 w-3.5" aria-hidden /> {run.findingsRejected.length + run.queriesRejected.length} refused
                          </span>
                        )}
                        {run.dnaBornId && (
                          <span className="inline-flex items-center gap-1 text-orange-700 dark:text-orange-300">
                            <Dna className="h-3.5 w-3.5" aria-hidden /> gene #{run.dnaBornId}
                          </span>
                        )}
                        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
                      </span>
                    </button>
                    {open && (
                      <div className="space-y-3 px-4 pb-4">
                        {run.analysis && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Analysis</div>
                            <p className="text-xs leading-relaxed">{run.analysis}</p>
                          </div>
                        )}
                        {run.queriesAccepted.length > 0 && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                              Query mutations accepted
                            </div>
                            <ul className="space-y-1">
                              {run.queriesAccepted.map((q) => (
                                <li key={q.q} className="flex flex-wrap gap-2 text-xs">
                                  <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{q.q}</code>
                                  <span className="text-muted-foreground">{q.why}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {run.findingsRejected.length > 0 && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
                              Findings refused — evidence not verifiable (invention attempts)
                            </div>
                            <ul className="space-y-1">
                              {run.findingsRejected.map((r, i) => (
                                <li key={i} className="text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">“{r.title}”</span> — {r.reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {run.queriesRejected.length > 0 && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
                              Queries refused
                            </div>
                            <ul className="space-y-1">
                              {run.queriesRejected.map((q, i) => (
                                <li key={i} className="text-xs text-muted-foreground">
                                  <code dir="ltr" className="font-mono">{q.q}</code> — {q.reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {run.note && (
                          <>
                            <Separator />
                            <p className="text-[11px] italic text-muted-foreground">{run.note}</p>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
