"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartLine,
  CheckCircle2,
  Clock,
  Dna,
  FlaskConical,
  Gauge,
  Satellite,
  Swords,
  Target,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { useLiveStore } from "@/lib/live-store";
import { useHydrated } from "@/hooks/use-hydrated";

// ============================================================
// The Insights tab — the analytics cockpit over /api/stats.
//
// Everything is read-only; the query refreshes faster while the
// SSE live wire is connected (the hook also invalidates ["stats"]
// on dna-born / chimera / llm events), and slower when polling
// is the only transport.
//
// Palette follows the app's accents (amber / emerald / rose /
// orange on stone) — no indigo/blue anywhere.
// ============================================================

// ---------- types (mirror of GET /api/stats) ----------

export interface StatsResponse {
  generatedAt: string;
  dna: {
    total: number;
    field: number;
    mined: number;
    kinds: { kind: string; count: number }[];
    growthDays: { day: string; born: number; total: number }[];
    topRepos: { repo: string; genes: number }[];
    latest: { name: string; repo: string; kind: string; at: string }[];
  };
  missions: { total: number; byStatus: { status: string; count: number }[] };
  hunts: {
    total: number;
    done: number;
    failed: number;
    running: number;
    llmCalls: number;
    avgElapsedMs: number;
    genesBorn: number;
  };
  sweeps: {
    total: number;
    done: number;
    avgQueries: number;
    avgDnaAdded: number;
    avgElapsedMs: number;
    avgLlmCalls: number;
  };
  chimeras: { total: number };
  llm: { days: { day: string; calls: number; costUsd: number }[]; total: { calls: number; costUsd: number } };
  modelRadar: {
    id: string;
    family: string;
    version: number;
    kind: "emerging" | "candidate";
    mentions: number;
    vouches: number;
    confirmed: boolean;
    lastSeen: string | null;
  }[];
}

// ---------- palette + helpers ----------

const AMBER = "#f59e0b";
const EMERALD = "#10b981";
const ROSE = "#f43f5e";
const ORANGE = "#f97316";
const GRID_STROKE = "#a8a29e";

/** "3m 20s" style durations — used for hunt/sweep averages. */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtMoney(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(3)}`;
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

const STATUS_LABEL: Record<string, string> = {
  done: "Completed",
  in_progress: "In progress",
  compiled: "Compiled",
  partial: "Partial",
  failed: "Failed",
  voided: "Voided — fiction",
};

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

const TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    fontSize: "11px",
    color: "var(--popover-foreground)",
  } as React.CSSProperties,
  labelStyle: { color: "var(--popover-foreground)", fontWeight: 600 },
  itemStyle: { color: "var(--popover-foreground)" },
  cursor: { fill: GRID_STROKE, fillOpacity: 0.15 },
};

// ---------- the panel ----------

export function InsightsPanel() {
  const token = useHunterStore((s) => s.token);
  const mounted = useHydrated();
  const connected = useLiveStore((s) => s.connected);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["stats"],
    queryFn: () => apiFetch<StatsResponse>("/api/stats", token),
    enabled: mounted,
    staleTime: 60_000,
    // live wire connected → events push fresh data, the poll can relax
    refetchInterval: connected ? 120_000 : 60_000,
  });

  if (!mounted || (isLoading && !data)) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-52 animate-pulse rounded-xl border bg-muted/40" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-3xl text-orange-600">!</p>
        <p className="mt-2 font-medium">Insights unavailable</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "The stats endpoint did not answer."}
        </p>
      </div>
    );
  }

  if (data.dna.total === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <Dna className="mx-auto h-8 w-8 text-violet-500" aria-hidden />
        <p className="mt-2 font-medium">The library is empty</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          Run a hunt or mine a repo first — every gene, mission and LLM call will start painting the
          charts here.
        </p>
      </div>
    );
  }

  const { dna, missions, hunts, sweeps, llm, modelRadar } = data;
  const kindsMax = Math.max(...dna.kinds.map((k) => k.count), 1);
  const repoChartHeight = dna.topRepos.length > 0 ? dna.topRepos.length * 28 + 24 : 120;
  const activeLlmDays = llm.days.filter((d) => d.calls > 0);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold">
          <ChartLine className="h-4 w-4 text-orange-600" aria-hidden />
          Intelligence insights
          <span className="font-normal text-muted-foreground">— 30-day analytics over the whole arsenal</span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          Computed {relative(data.generatedAt)}
          {connected && <span className="ml-1.5 text-emerald-600 dark:text-emerald-400">· live</span>}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* 1. DNA growth */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Dna className="h-5 w-5 text-violet-600" aria-hidden />
              DNA growth
              <span className="ml-auto flex flex-wrap gap-3 font-normal">
                <LegendDot color={AMBER} label="born / day" />
                <LegendDot color={EMERALD} label="library total" />
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground">
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={dna.growthDays} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.25} vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    interval={4}
                    tickLine={false}
                    axisLine={{ stroke: GRID_STROKE, strokeOpacity: 0.4 }}
                  />
                  <YAxis
                    yAxisId="left"
                    allowDecimals={false}
                    width={32}
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    allowDecimals={false}
                    width={40}
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip {...TOOLTIP_PROPS} />
                  <Bar yAxisId="left" dataKey="born" name="born" fill={AMBER} fillOpacity={0.8} radius={[3, 3, 0, 0]} />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="total"
                    name="total"
                    stroke={EMERALD}
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* 2. Library composition */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="h-5 w-5 text-violet-600" aria-hidden />
              Library composition
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Total", value: dna.total },
                { label: "Field-born", value: dna.field },
                { label: "Mined", value: dna.mined },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/30 p-2 text-center">
                  <p className="text-xl font-bold tabular-nums">{s.value.toLocaleString()}</p>
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {dna.kinds
                .slice()
                .sort((a, b) => b.count - a.count)
                .slice(0, 6)
                .map((k) => (
                  <div key={k.kind} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono">{k.kind}</span>
                      <span className="tabular-nums text-muted-foreground">{k.count}</span>
                    </div>
                    <Progress value={(k.count / kindsMax) * 100} className="h-1.5" />
                  </div>
                ))}
            </div>
            {dna.latest.length > 0 && (
              <div className="space-y-1 border-t pt-3">
                <p className="text-[11px] font-semibold text-muted-foreground">Latest additions</p>
                {dna.latest.slice(0, 4).map((g) => (
                  <div key={`${g.name}-${g.at}`} className="flex items-center gap-2 text-[11px]">
                    <Badge variant="outline" className="shrink-0 px-1 py-0 font-mono text-[9px]">
                      {g.kind}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono" title={`${g.name} · ${g.repo}`}>
                      {g.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{relative(g.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 3. Top DNA sources */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-orange-600" aria-hidden />
              Top DNA sources
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dna.topRepos.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No mined DNA yet — genes appear here after a sweep or a manual mine.
              </p>
            ) : (
              <div className="text-muted-foreground">
                <ResponsiveContainer width="100%" height={repoChartHeight}>
                  <BarChart data={dna.topRepos} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.25} horizontal={false} />
                    <XAxis
                      type="number"
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickLine={false}
                      axisLine={{ stroke: GRID_STROKE, strokeOpacity: 0.4 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="repo"
                      width={110}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip {...TOOLTIP_PROPS} cursor={{ fill: GRID_STROKE, fillOpacity: 0.12 }} />
                    <Bar dataKey="genes" name="genes" fill={ORANGE} fillOpacity={0.85} radius={[0, 3, 3, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 4. Mission funnel */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-5 w-5 text-fuchsia-600" aria-hidden />
              Mission funnel
              <span className="ml-auto text-xl font-bold tabular-nums">{missions.total}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {missions.total === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No missions compiled yet.</p>
            ) : (
              <div className="space-y-2">
                {missions.byStatus
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((s) => (
                    <div key={s.status} className="flex items-center gap-2">
                      <Badge variant="outline" className="w-28 shrink-0 justify-center text-[10px]">
                        {STATUS_LABEL[s.status] ?? s.status}
                      </Badge>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-fuchsia-500/70"
                          style={{ width: `${(s.count / missions.total) * 100}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.count}</span>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 5. Hunts & sweeps */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Swords className="h-5 w-5 text-orange-600" aria-hidden />
              Hunts &amp; sweeps
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Swords className="h-3 w-3" aria-hidden /> Hunts
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Total", value: hunts.total.toLocaleString() },
                  { label: "Done", value: hunts.done.toLocaleString() },
                  { label: "Failed", value: hunts.failed.toLocaleString() },
                  { label: "LLM calls", value: hunts.llmCalls.toLocaleString() },
                  { label: "Genes born", value: hunts.genesBorn.toLocaleString() },
                  { label: "Avg run", value: fmtDur(hunts.avgElapsedMs) },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border bg-muted/30 p-2 text-center">
                    <p className="text-sm font-bold tabular-nums">{s.value}</p>
                    <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Satellite className="h-3 w-3" aria-hidden /> Sweeps (avg, last {sweeps.total})
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Queries", value: sweeps.avgQueries.toLocaleString() },
                  { label: "DNA added", value: sweeps.avgDnaAdded.toLocaleString() },
                  { label: "Duration", value: fmtDur(sweeps.avgElapsedMs) },
                  { label: "LLM calls", value: sweeps.avgLlmCalls.toLocaleString() },
                  { label: "Runs", value: sweeps.total.toLocaleString() },
                  { label: "Done", value: sweeps.done.toLocaleString() },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border bg-muted/30 p-2 text-center">
                    <p className="text-sm font-bold tabular-nums">{s.value}</p>
                    <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 6. LLM daily usage */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-5 w-5 text-amber-600" aria-hidden />
              LLM daily usage
              <span className="ml-auto flex flex-wrap gap-3 font-normal">
                <LegendDot color={AMBER} label="calls / day" />
                <LegendDot color={ROSE} label="cost ($)" />
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeLlmDays.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No LLM usage recorded yet — run a hunt or a sweep and the ledger starts here.
              </p>
            ) : (
              <div className="text-muted-foreground">
                <ResponsiveContainer width="100%" height={180}>
                  <ComposedChart data={llm.days} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.25} vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      interval={4}
                      tickLine={false}
                      axisLine={{ stroke: GRID_STROKE, strokeOpacity: 0.4 }}
                    />
                    <YAxis
                      yAxisId="left"
                      allowDecimals={false}
                      width={32}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      width={40}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip {...TOOLTIP_PROPS} />
                    <Bar yAxisId="left" dataKey="calls" name="calls" fill={AMBER} fillOpacity={0.8} radius={[3, 3, 0, 0]} />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="costUsd"
                      name="cost ($)"
                      stroke={ROSE}
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-3 text-xs">
              <span>
                <strong className="tabular-nums">{llm.total.calls.toLocaleString()}</strong>
                <span className="text-muted-foreground"> calls total</span>
              </span>
              <span>
                <strong className="tabular-nums">{fmtMoney(llm.total.costUsd)}</strong>
                <span className="text-muted-foreground"> lifetime cost</span>
              </span>
              <span className="text-muted-foreground">{activeLlmDays.length} active day(s) in the ledger</span>
            </div>
          </CardContent>
        </Card>

        {/* 7. Model radar */}
        <Card className="md:col-span-2 xl:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ChartLine className="h-5 w-5 text-rose-600" aria-hidden />
              Model radar
              <span className="ml-auto font-normal text-xs text-muted-foreground">
                emerging + candidate versions observed above the registry
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modelRadar.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nothing above the registry on the radar — the frontier is calm.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Mentions</TableHead>
                      <TableHead className="text-right">Vouches</TableHead>
                      <TableHead>Confirmed</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRadar.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">
                          <span className="font-semibold">{m.family}</span>{" "}
                          <span className="tabular-nums">{m.version}</span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">{m.id}</span>
                        </TableCell>
                        <TableCell>
                          {m.kind === "emerging" ? (
                            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                              emerging
                            </Badge>
                          ) : (
                            <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                              candidate
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{m.mentions.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.vouches.toLocaleString()}</TableCell>
                        <TableCell>
                          {m.confirmed ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Confirmed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Clock className="h-3.5 w-3.5" aria-hidden /> Awaiting authority
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{relative(m.lastSeen)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
