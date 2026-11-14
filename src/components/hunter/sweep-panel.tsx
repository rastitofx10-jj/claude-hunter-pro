"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Satellite,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Search,
  Database,
  Brain,
  Crosshair,
  Clock,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Target,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { useHunterStore } from "@/lib/hunter-store";
import { useLiveStore } from "@/lib/live-store";
import { apiFetch } from "@/lib/api-client";

// ---------- types ----------

interface QueryReport {
  q: string;
  kind: string;
  origin: string;
  count: number;
  error?: string;
}

interface SweepStats {
  queriesRun?: number;
  queryErrors?: number;
  codeHits?: number;
  repoHits?: number;
  candidatesFound?: number;
  enriched?: number;
  hardEvidence?: number;
  reposMined?: number;
  /** Repos that actually yielded artifacts — "mined" used to include repos that were wiped clean with nothing */
  reposWithFindings?: number;
  mineErrors?: number;
  mineErrorList?: string[];
  dnaAdded?: number;
  totalLibrary?: number;
  fieldDna?: number;
  llmCalls?: number;
  llmFailures?: number;
  eliteCount?: number;
  elapsedMs?: number;
}

interface Finding {
  fullName: string;
  stars: number;
  description: string | null;
  modelStrings: string[];
  capabilityHits: number;
  evidence: "hard" | "soft" | "none";
  score: number;
  tierLabel: string;
  verdict: "elite" | "watch" | "noise" | null;
  confidence: number | null;
  triageReason: string | null;
  investment: number | null;
  signature: string | null;
  stealThis: string[];
  blindSpot: string | null;
}

interface Briefing {
  triage?: { fullName: string; verdict: string; confidence: number; reason: string }[];
  profiles?: { fullName: string; investment: number; moneyLevel: string; signature: string; stealThis: string[]; blindSpot: string }[];
  patterns?: { patterns: { pattern: string; repos: string[]; insight: string }[]; stackConsensus: string[]; marketShift: string };
  attack?: { topMoves: { move: string; why: string; effort: string }[]; differentiators: string[]; immediateActions: string[] };
  queryEvolution?: { nextQueries: string[]; blindSpots: string[]; rationale: string };
  brief?: { headline: string; keyIntel: string[]; decisiveMove: string; riskMap: string[] };
  llmCalls?: number;
  llmFailures?: string[];
}

interface AuditResult {
  status: "running" | "done" | "failed";
  stage: string;
  evidenceChecks: { fullName: string; claimed: string; filesFound: number; verified: boolean; proofFile?: string; error?: string }[];
  precision: number;
  specificityScore: number;
  slopFlags: { claim: string; why: string }[];
  refutedClaims: { claim: string; why: string }[];
  verdict: string;
  llmCalls: number;
  error?: string;
  auditedAt?: string;
}

interface SweepDetail {
  id: number;
  status: "running" | "done" | "failed";
  phase: string;
  progress: number;
  queries: QueryReport[];
  stats: SweepStats;
  findings: Finding[];
  briefing: Briefing | null;
  audit: AuditResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SweepListItem {
  id: number;
  status: string;
  phase: string;
  progress: number;
  stats: SweepStats;
  error: string | null;
  createdAt: string;
}

const PHASES: { key: string; label: string; icon: typeof Search }[] = [
  { key: "queries", label: "Queries", icon: Search },
  { key: "enrich", label: "Enrich", icon: TrendingUp },
  { key: "mine", label: "DNA mining", icon: Database },
  { key: "swarm", label: "Prompt swarm", icon: Brain },
  { key: "done", label: "Briefing", icon: Crosshair },
];

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  elite: { label: "Elite", cls: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800" },
  watch: { label: "Watch", cls: "bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800" },
  noise: { label: "Noise", cls: "bg-muted text-muted-foreground border-border" },
};

export function SweepPanel() {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const logRef = useRef<HTMLDivElement>(null);
  // SSE connected → sweep events invalidate the queries instantly, so the
  // polling intervals below relax (4s→12s list, 2.5s→8s detail) while live.
  const liveConnected = useLiveStore((s) => s.connected);

  const listQuery = useQuery({
    queryKey: ["sweep-list"],
    queryFn: () => apiFetch<{ items: SweepListItem[]; active: SweepListItem | null }>("/api/sweep", token),
    // Refresh the list while a run is active — the history (including "in flight %")
    // used to update only on launch or window focus, going minutes-stale mid-run.
    refetchInterval: (q) => (q.state.data?.active ? (liveConnected ? 12000 : 4000) : false),
  });

  const activeId = listQuery.data?.active?.id ?? null;
  const [viewId, setViewId] = useState<number | null>(null);
  const selectedId = viewId ?? activeId ?? listQuery.data?.items?.[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ["sweep-detail", selectedId],
    queryFn: () => apiFetch<SweepDetail>(`/api/sweep/${selectedId}`, token),
    enabled: selectedId !== null,
    refetchInterval: (q) =>
      q.state.data?.status === "running" || q.state.data?.audit?.status === "running"
        ? liveConnected
          ? 8000
          : 2500
        : false,
  });

  // Auto-scroll the query log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [detailQuery.data?.queries?.length]);

  const launch = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; id: number }>("/api/sweep", token, { method: "POST" }),
    onSuccess: (data) => {
      toast({ title: "Deep sweep launched 🛰️", description: `Run #${data.id} is in flight — tracking it now` });
      // Auto-follow the new run — viewId used to stick to a previously selected older run
      // and the user never saw the run they just launched until clicking manually.
      setViewId(data.id);
      void qc.invalidateQueries({ queryKey: ["sweep-list"] });
    },
    onError: (e: Error) => toast({ title: "Launch failed", description: e.message, variant: "destructive" }),
  });

  const launchAudit = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; id: number }>(`/api/sweep/${selectedId}/audit`, token, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Adversarial audit launched 🔥", description: "Verifying every piece of evidence against GitHub and running anti-slop" });
      void qc.invalidateQueries({ queryKey: ["sweep-detail", selectedId] });
    },
    onError: (e: Error) => toast({ title: "Audit failed", description: e.message, variant: "destructive" }),
  });

  const detail = detailQuery.data;
  const running = detail?.status === "running";
  const briefing = detail?.briefing ?? null;
  const audit = detail?.audit ?? null;
  const stats = detail?.stats ?? {};

  const phaseIndex = useMemo(() => {
    if (!detail) return -1;
    const i = PHASES.findIndex((p) => p.key === detail.phase);
    return i;
  }, [detail]);

  const queriesDone = (detail?.queries ?? []).length;

  return (
    <div className="space-y-5">
      {/* launcher */}
      <Card className="border-orange-200 bg-gradient-to-l from-orange-50/80 to-transparent dark:border-orange-900 dark:from-orange-950/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Satellite className="h-5 w-5 text-orange-600" aria-hidden />
            Deep Sweep — Full Intelligence Operation
          </CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A full arsenal of GitHub queries (code + repos, every real registered model) → metadata enrichment → DNA mining
            from the elite → <strong>prompt swarm</strong>: 8 professional prompts — triage, investment profiles, market
            patterns, attack plan, query evolution, and an executive briefing.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button
            size="lg"
            onClick={() => launch.mutate()}
            disabled={launch.isPending || !!listQuery.data?.active}
            className="min-h-11"
          >
            {launch.isPending || listQuery.data?.active ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )}
            {listQuery.data?.active ? `Sweep #${listQuery.data.active.id} in flight` : "Launch deep sweep"}
          </Button>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">26 GitHub queries</Badge>
            <Badge variant="outline">7-10 prompts (depending on elite size)</Badge>
            <Badge variant="outline">Up to ~8 minutes in the background</Badge>
          </div>
        </CardContent>
      </Card>

      {/* current / selected run */}
      {detail && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                Operation #{detail.id}
                {detail.status === "running" && (
                  <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> In flight
                  </Badge>
                )}
                {detail.status === "done" && (
                  <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" aria-hidden /> Completed
                  </Badge>
                )}
                {detail.status === "failed" && (
                  <Badge variant="destructive">
                    <XCircle className="h-3 w-3" aria-hidden /> Failed
                  </Badge>
                )}
              </span>
              <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {new Date(detail.createdAt).toLocaleTimeString("en-US")}
                {stats.elapsedMs ? ` · ${Math.round(stats.elapsedMs / 1000)} seconds` : ""}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* progress meter + phases */}
            <div className="space-y-2">
              <Progress value={detail.progress} className="h-2" aria-label={`Progress ${detail.progress}%`} />
              <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                {PHASES.map((p, i) => {
                  const Icon = p.icon;
                  const state = i < phaseIndex ? "done" : i === phaseIndex ? "active" : "pending";
                  return (
                    <span
                      key={p.key}
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                        state === "done"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : state === "active"
                            ? "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300"
                            : "border-border text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-3 w-3" aria-hidden />
                      {p.label}
                      {p.key === "queries" && queriesDone > 0 && ` (${queriesDone})`}
                    </span>
                  );
                })}
              </div>
              {detail.error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{detail.error}</p>
              )}
            </div>

            {/* live query log */}
            {(detail.queries?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
                  <Search className="h-4 w-4" aria-hidden /> Query Log
                  <span className="text-xs font-normal text-muted-foreground">
                    {stats.queryErrors ? ` · ${stats.queryErrors} errors` : ""}
                  </span>
                </p>
                <div
                  ref={logRef}
                  className="max-h-44 overflow-y-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs"
                  dir="ltr"
                >
                  {detail.queries.map((q, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 py-0.5">
                      <span className="truncate text-muted-foreground">
                        <span className="mr-1 text-orange-600">{q.kind === "code" ? "code" : "repo"}</span>
                        {q.q}
                      </span>
                      <span className={`shrink-0 ${q.error ? "text-destructive" : "text-emerald-600"}`}>
                        {q.error ? "ERR" : q.count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* statistics */}
            {stats.queriesRun ? (
              <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {[
                  { label: "Queries", value: stats.queriesRun ?? 0 },
                  { label: "Code hits", value: stats.codeHits ?? 0 },
                  { label: "Candidates", value: stats.candidatesFound ?? 0 },
                  { label: "Hard evidence", value: stats.hardEvidence ?? 0 },
                  { label: "DNA added", value: stats.dnaAdded ?? 0 },
                  { label: "Prompts", value: stats.llmCalls ?? 0 },
                  { label: "Elite", value: stats.eliteCount ?? 0 },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border bg-muted/30 p-2 text-center">
                    <p className="text-lg font-bold text-orange-600">{s.value.toLocaleString()}</p>
                    <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
              {/* Mining honesty: "N repos mined" used to hide repos wiped clean with nothing, plus mining failures */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Mining: {stats.reposWithFindings ?? 0}/{stats.reposMined ?? 0} repos yielded genes</span>
                {stats.mineErrors ? (
                  <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300" title={(stats.mineErrorList ?? []).join(" | ")}>
                    {stats.mineErrors} mining failures
                  </span>
                ) : null}
              </div>
              </>
            ) : null}

            {/* executive briefing */}
            {briefing?.brief?.headline && (
              <div className="rounded-xl border border-orange-300 bg-orange-50/60 p-4 dark:border-orange-800 dark:bg-orange-950/20">
                <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-orange-800 dark:text-orange-200">
                  <Crosshair className="h-4 w-4" aria-hidden /> {briefing.brief.headline}
                </p>
                {(briefing.brief.keyIntel?.length ?? 0) > 0 && (
                  <ul className="mt-2 space-y-1 text-sm leading-relaxed">
                    {briefing.brief.keyIntel.map((k, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-orange-500">▸</span>
                        <span>{k}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {briefing.brief.decisiveMove && (
                  <p className="mt-3 rounded-md border bg-card p-2 text-sm">
                    <strong>Decisive move:</strong> {briefing.brief.decisiveMove}
                  </p>
                )}
                {(briefing.brief.riskMap?.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {briefing.brief.riskMap.map((r, i) => (
                      <span key={i} className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                        <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* adversarial audit */}
            <div className="rounded-xl border border-red-200 bg-red-50/40 p-4 dark:border-red-900 dark:bg-red-950/10">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-bold text-red-800 dark:text-red-300">
                  <ShieldCheck className="h-4 w-4" aria-hidden /> Adversarial audit — the part the system fears
                </p>
                {detail.status === "done" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => launchAudit.mutate()}
                    disabled={launchAudit.isPending || audit?.status === "running"}
                    className="min-h-9 border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300"
                  >
                    {audit?.status === "running" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        Auditing ruthlessly… ({audit.stage})
                      </>
                    ) : (
                      "Run ruthless audit"
                    )}
                  </Button>
                )}
              </div>

              {audit?.status === "failed" && (
                <p className="text-xs text-destructive">Audit failed: {audit.error}</p>
              )}

              {audit?.status === "done" && (
                <div className="space-y-3">
                  {/* scores */}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-lg border bg-card p-2 text-center">
                      <p className={`text-2xl font-bold ${audit.precision >= 90 ? "text-emerald-600" : audit.precision >= 70 ? "text-amber-600" : "text-red-600"}`}>
                        {audit.precision}%
                      </p>
                      <p className="text-[11px] text-muted-foreground">Live evidence accuracy</p>
                    </div>
                    <div className="rounded-lg border bg-card p-2 text-center">
                      <p className={`text-2xl font-bold ${audit.specificityScore >= 80 ? "text-emerald-600" : audit.specificityScore >= 60 ? "text-amber-600" : "text-red-600"}`}>
                        {audit.specificityScore}/100
                      </p>
                      <p className="text-[11px] text-muted-foreground">Anti-slop score</p>
                    </div>
                    <div className="rounded-lg border bg-card p-2 text-center">
                      <p className="text-2xl font-bold">{audit.evidenceChecks.length}</p>
                      <p className="text-[11px] text-muted-foreground">Evidence verified live</p>
                    </div>
                    <div className="rounded-lg border bg-card p-2 text-center">
                      <p className="text-2xl font-bold text-red-600">{audit.slopFlags.length + audit.refutedClaims.length}</p>
                      <p className="text-[11px] text-muted-foreground">Slop/refuted found</p>
                    </div>
                  </div>

                  {/* evidence verification table */}
                  <div className="max-h-52 overflow-y-auto rounded-lg border" role="region" aria-label="Evidence verification results">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                        <tr className="text-right text-xs text-muted-foreground">
                          <th className="p-2 font-medium">Repo</th>
                          <th className="p-2 font-medium">Claimed evidence</th>
                          <th className="p-2 font-medium">Files in repo</th>
                          <th className="p-2 font-medium">Verdict</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.evidenceChecks.map((c) => (
                          <tr key={c.fullName} className={`border-t ${!c.verified && !c.error ? "bg-red-50/60 dark:bg-red-950/20" : c.error ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}>
                            <td className="max-w-44 p-2">
                              <span dir="ltr" className="block truncate text-right font-mono text-xs">{c.fullName}</span>
                            </td>
                            <td className="p-2 font-mono text-xs" dir="ltr">
                              {c.claimed}
                              {c.proofFile && (
                                <span dir="ltr" className="block truncate text-right text-[10px] text-emerald-600">📄 {c.proofFile}</span>
                              )}
                            </td>
                            <td className="p-2 text-xs font-bold">{c.error ? "—" : c.filesFound}</td>
                            <td className="p-2 text-xs">
                              {c.verified ? (
                                <span className="font-bold text-emerald-600">✓ Verified</span>
                              ) : c.error ? (
                                // An API error is not a refutation — it used to render as "refuted" in red
                                // and true evidence got dismissed over a technical failure of the verifier
                                <span className="font-bold text-amber-600" title={c.error}>⚠️ Unverified (check error)</span>
                              ) : (
                                <span className="font-bold text-red-600">✗ Refuted</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {audit.verdict && (
                    <p className="rounded-md border bg-card p-2 text-sm leading-relaxed">
                      <strong>Audit verdict:</strong> {audit.verdict}
                    </p>
                  )}

                  {(audit.refutedClaims?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-bold text-red-700 dark:text-red-300">Claims refuted by the live verification</p>
                      <ul className="space-y-1 text-xs leading-relaxed">
                        {audit.refutedClaims.map((r, i) => (
                          <li key={i} className="rounded-md border border-red-200 bg-red-50/70 p-1.5 dark:border-red-900 dark:bg-red-950/20">
                            <span className="font-medium">{r.claim.slice(0, 160)}</span>
                            {r.why && <span className="block text-muted-foreground">{r.why.slice(0, 160)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(audit.slopFlags?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-bold text-amber-700 dark:text-amber-300">Slop flags — generic / unsupported by evidence</p>
                      <ul className="space-y-1 text-xs leading-relaxed">
                        {audit.slopFlags.map((s, i) => (
                          <li key={i} className="rounded-md border border-amber-200 bg-amber-50/70 p-1.5 dark:border-amber-900 dark:bg-amber-950/20">
                            <span className="font-medium">{s.claim.slice(0, 160)}</span>
                            {s.why && <span className="block text-muted-foreground">{s.why.slice(0, 160)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* findings table */}
            {(detail.findings?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1.5 text-sm font-semibold">Ranked findings ({detail.findings.length})</p>
                <div className="max-h-96 overflow-y-auto rounded-lg border" role="region" aria-label="Findings list">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                      <tr className="text-right text-xs text-muted-foreground">
                        <th className="p-2 font-medium">#</th>
                        <th className="p-2 font-medium">Repo</th>
                        <th className="p-2 font-medium">⭐</th>
                        <th className="p-2 font-medium">Evidence</th>
                        <th className="p-2 font-medium">Verdict</th>
                        <th className="p-2 font-medium">Investment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.findings.map((f, i) => {
                        const vs = f.verdict ? VERDICT_STYLE[f.verdict] : null;
                        return (
                          <tr key={f.fullName} className="border-t">
                            <td className="p-2 text-xs text-muted-foreground">{i + 1}</td>
                            <td className="max-w-52 p-2">
                              <p dir="ltr" className="truncate text-right font-mono text-xs font-medium">{f.fullName}</p>
                              {f.triageReason && <p className="truncate text-[11px] text-muted-foreground">{f.triageReason}</p>}
                            </td>
                            <td className="p-2 text-xs">{f.stars.toLocaleString()}</td>
                            <td className="p-2">
                              <span className={`text-xs ${f.evidence === "hard" ? "font-bold text-orange-600" : "text-muted-foreground"}`}>
                                {f.evidence === "hard" ? "Hard" : f.evidence === "soft" ? "Soft" : "—"}
                              </span>
                            </td>
                            <td className="p-2">
                              {vs ? (
                                <span className={`rounded-full border px-2 py-0.5 text-xs ${vs.cls}`}>{vs.label}</span>
                              ) : (
                                <span className="text-xs text-muted-foreground">Pending</span>
                              )}
                            </td>
                            <td className="p-2 text-xs">
                              {f.investment !== null ? (
                                <span className={f.investment >= 70 ? "font-bold text-orange-600" : ""}>{f.investment}/100</span>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* patterns + attack plan */}
            {briefing?.patterns && briefing.patterns.patterns.length > 0 && (
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                    <TrendingUp className="h-4 w-4" aria-hidden /> Market Patterns
                  </p>
                  {briefing.patterns.marketShift && (
                    <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{briefing.patterns.marketShift}</p>
                  )}
                  <ul className="space-y-2">
                    {briefing.patterns.patterns.map((p, i) => (
                      <li key={i} className="rounded-lg bg-muted/40 p-2 text-sm">
                        <p className="font-medium">{p.pattern}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{p.insight}</p>
                      </li>
                    ))}
                  </ul>
                </div>
                {briefing.attack && (
                  <div className="rounded-xl border p-3">
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                      <Target className="h-4 w-4" aria-hidden /> Attack Plan
                    </p>
                    <ul className="space-y-1.5">
                      {briefing.attack.topMoves.map((m, i) => (
                        <li key={i} className="text-sm">
                          <span className="font-medium">{m.move}</span>
                          <Badge variant="outline" className="mr-1.5 px-1.5 py-0 text-[10px]">{m.effort}</Badge>
                          {m.why && <p className="text-xs text-muted-foreground">{m.why}</p>}
                        </li>
                      ))}
                    </ul>
                    {(briefing.attack.immediateActions?.length ?? 0) > 0 && (
                      <div className="mt-2 rounded-lg border border-orange-200 bg-orange-50/50 p-2 dark:border-orange-900 dark:bg-orange-950/20">
                        <p className="mb-1 text-xs font-bold text-orange-700 dark:text-orange-300">Next 48 hours</p>
                        <ul className="space-y-0.5 text-xs">
                          {briefing.attack.immediateActions.map((a, i) => (
                            <li key={i}>• {a}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* query evolution for the next round */}
            {(briefing?.queryEvolution?.nextQueries?.length ?? 0) > 0 && (
              <div className="rounded-xl border p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
                  <Lightbulb className="h-4 w-4" aria-hidden /> Next round — AI-recommended queries
                </p>
                {briefing!.queryEvolution!.rationale && (
                  <p className="mb-2 text-xs text-muted-foreground">{briefing!.queryEvolution!.rationale}</p>
                )}
                <div className="flex flex-wrap gap-1.5" dir="ltr">
                  {briefing!.queryEvolution!.nextQueries.map((q, i) => (
                    <code key={i} className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-xs">{q}</code>
                  ))}
                </div>
              </div>
            )}

            {/* partial swarm failures */}
            {(briefing?.llmFailures?.length ?? 0) > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
                {briefing!.llmFailures!.length} prompts failed: {briefing!.llmFailures!.join(" · ")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* load error — before: a silent 500 from the server was completely invisible in the UI */}
      {(listQuery.isError || detailQuery.isError) && (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/20 dark:text-red-300" role="alert">
          <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden />
          Failed to load sweep data: {((listQuery.error as Error)?.message || (detailQuery.error as Error)?.message || "Network error")}
        </div>
      )}

      {/* sweep history */}
      {(listQuery.data?.items?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Operation History</CardTitle>
          </CardHeader>
          <CardContent className="max-h-60 space-y-1.5 overflow-y-auto">
            {listQuery.data!.items.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-2 text-sm transition-colors hover:border-orange-300"
                role="button"
                tabIndex={0}
                onClick={() => setViewId(r.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setViewId(r.id)}
                aria-pressed={selectedId === r.id}
                style={selectedId === r.id ? { borderColor: "var(--orange-400, #fb923c)" } : undefined}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">#{r.id}</span>
                  {r.status === "running" ? (
                    <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300">In flight {r.progress}%</Badge>
                  ) : r.status === "done" ? (
                    <Badge variant="outline" className="text-emerald-600">Completed</Badge>
                  ) : (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                  {r.stats?.eliteCount ? <span className="text-xs text-muted-foreground">Elite: {r.stats.eliteCount}</span> : null}
                  {r.stats?.dnaAdded ? <span className="text-xs text-muted-foreground">DNA +{r.stats.dnaAdded}</span> : null}
                  {r.stats?.llmCalls ? <span className="text-xs text-muted-foreground">Prompts: {r.stats.llmCalls}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString("en-US")}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
