"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, type Variants } from "framer-motion";
import {
  Dna,
  Swords,
  Target,
  Gauge,
  Sparkles,
  Rocket,
  Satellite,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronLeft,
  Brain,
  Clock,
  FlaskConical,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetch, SERVER_TOKEN } from "@/lib/api-client";
import { useHunterStore, type TabKey } from "@/lib/hunter-store";
import { THRESHOLD_LABEL, THRESHOLD_RULE_TEXT } from "@/lib/claude-models";
import type { RateInfo } from "@/lib/hunter-types";
import { useHydrated } from "@/hooks/use-hydrated";

// ---------- local types (mirror of the API responses, kept lean) ----------

interface MissionListResponse {
  items: { id: number; missionName: string; goal: string; status: string; createdAt: string; hasReport: boolean }[];
  stats: { totalDna: number; fieldDna: number };
}
interface HuntListResponse {
  items?: {
    id: number;
    status: string;
    stageKey: string;
    goal: string;
    missionId: number | null;
    generation: number;
    seededFrom: number | null;
    dnaBefore: number;
    dnaAfter: number;
    llmCalls: number;
    elapsedMs: number;
    error: string | null;
    createdAt: string;
    stagesCount: number;
  }[];
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

const STATUS_STYLE: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  in_progress: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  compiled: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  partial: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};
const STATUS_LABEL: Record<string, string> = {
  done: "הושלמה",
  in_progress: "בביצוע",
  compiled: "הודרה",
  partial: "חלקית",
  failed: "נכשלה",
};

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: 0.05 * i, duration: 0.35, ease: "easeOut" } }),
};

export function Overview({ onNavigate }: { onNavigate: (t: TabKey) => void }) {
  const token = useHunterStore((s) => s.token);
  const mounted = useHydrated();
  // (בעבר: !!token || token === SERVER_TOKEN — הפסקה השנייה תמיד-אמת כשהראשונה אמיתית)
  const hasToken = mounted && !!token;

  const { data: missionData } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiFetch<MissionListResponse>("/api/mission", token),
  });
  const { data: huntData } = useQuery({
    queryKey: ["live-hunt-list"],
    queryFn: () => apiFetch<HuntListResponse>("/api/live-hunt", token),
  });
  const { data: rate } = useQuery({
    queryKey: ["rate", token],
    queryFn: () => apiFetch<RateInfo>("/api/rate-limit", token),
    staleTime: 60_000,
  });

  const hunts = huntData?.items ?? [];
  const missions = missionData?.items ?? [];
  const lastHunt = hunts[0] ?? null;
  const runningHunt = hunts.find((h) => h.status === "running") ?? null;
  const totalDna = missionData?.stats?.totalDna ?? 0;
  const fieldDna = missionData?.stats?.fieldDna ?? 0;
  const doneMissions = missions.filter((m) => m.status === "done").length;

  const activity = useMemo(() => {
    const items: { key: string; kind: "hunt" | "mission"; when: number; node: React.ReactNode }[] = [];
    for (const h of hunts.slice(0, 4)) {
      items.push({
        key: `hunt-${h.id}`,
        kind: "hunt",
        when: new Date(h.createdAt).getTime() || 0,
        node: (
          <button
            onClick={() => onNavigate("live")}
            className="flex w-full items-center gap-2 rounded-lg p-2 text-start transition-colors hover:bg-muted/50"
          >
            <Swords className="h-4 w-4 shrink-0 text-orange-600" />
            <span className="shrink-0 text-xs font-semibold">ציד #{h.id}</span>
            {h.generation > 1 && <Badge variant="secondary" className="text-[10px]">דור {h.generation}</Badge>}
            {h.status === "done" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            ) : h.status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="auto">
              {h.goal || h.error || "—"}
            </span>
            {h.dnaAfter > h.dnaBefore && (
              <Badge className="bg-emerald-500/90 text-[10px] text-white">+{h.dnaAfter - h.dnaBefore} 🧬</Badge>
            )}
          </button>
        ),
      });
    }
    for (const m of missions.slice(0, 4)) {
      items.push({
        key: `mission-${m.id}`,
        kind: "mission",
        when: new Date(m.createdAt).getTime() || 0,
        node: (
          <button
            onClick={() => onNavigate("mission")}
            className="flex w-full items-center gap-2 rounded-lg p-2 text-start transition-colors hover:bg-muted/50"
          >
            <Target className="h-4 w-4 shrink-0 text-violet-600" />
            <span dir="ltr" className="shrink-0 font-mono text-xs font-semibold text-violet-700 dark:text-violet-300">
              {m.missionName}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[m.status] ?? ""}`}>
              {STATUS_LABEL[m.status] ?? m.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="auto">
              {m.goal}
            </span>
          </button>
        ),
      });
    }
    return items.sort((a, b) => b.when - a.when).slice(0, 7);
  }, [hunts, missions, onNavigate]);

  const kpis = [
    {
      label: "ספריית DNA",
      value: totalDna.toLocaleString(),
      sub: `${fieldDna} נולדו מהשדה`,
      icon: Dna,
      cls: "from-violet-500/15 text-violet-600 dark:text-violet-300",
      tab: "genesis" as TabKey,
    },
    {
      label: "משימות",
      value: missions.length.toLocaleString(),
      sub: `${doneMissions} הושלמו`,
      icon: Target,
      cls: "from-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300",
      tab: "mission" as TabKey,
    },
    {
      label: "צידים חיים",
      value: hunts.length.toLocaleString(),
      sub: lastHunt ? `אחרון: #${lastHunt.id} · דור ${lastHunt.generation}` : "טרם צדת",
      icon: Swords,
      cls: "from-orange-500/15 text-orange-600 dark:text-orange-300",
      tab: "live" as TabKey,
    },
    {
      label: "מכסת GitHub",
      value: rate?.core ? `${rate.core.remaining}/${rate.core.limit}` : "—",
      sub: rate?.error ? "שגיאת טוקן" : hasToken ? "מחובר" : "ללא טוקן — מוגבל",
      icon: Gauge,
      cls: "from-emerald-500/15 text-emerald-600 dark:text-emerald-300",
      tab: "search" as TabKey,
    },
  ];

  return (
    <div className="space-y-5" dir="rtl">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {kpis.map((k, i) => (
          <motion.div key={k.label} custom={i} variants={fadeUp} initial="hidden" animate="show">
            <Card
              role="button"
              tabIndex={0}
              onClick={() => onNavigate(k.tab)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onNavigate(k.tab)}
              className={`cursor-pointer bg-gradient-to-bl to-transparent transition-all hover:shadow-md hover:-translate-y-0.5 ${k.cls}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">{k.label}</p>
                  <k.icon className="h-4 w-4 opacity-80" aria-hidden />
                </div>
                <p className="mt-2 text-2xl font-bold tabular-nums">{k.value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{k.sub}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Quick actions */}
      <motion.div custom={4} variants={fadeUp} initial="hidden" animate="show">
        <Card className="border-orange-200/70 bg-gradient-to-l from-orange-50/70 via-card to-card dark:border-orange-900 dark:from-orange-950/20">
          <CardContent className="flex flex-wrap items-center gap-2 p-4">
            <p className="flex items-center gap-1.5 text-sm font-bold">
              <Rocket className="h-4 w-4 text-orange-600" /> פעולות מהירות
            </p>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button size="sm" className="gap-1.5 bg-gradient-to-l from-orange-600 to-amber-500 text-white hover:from-orange-700 hover:to-amber-600" onClick={() => onNavigate("live")}>
                <Swords className="h-3.5 w-3.5" /> {runningHunt ? `ציד #${runningHunt.id} רץ כרגע` : "ציד חי חדש"}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onNavigate("mission")}>
                <Target className="h-3.5 w-3.5" /> הדר משימה
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onNavigate("sweep")}>
                <Satellite className="h-3.5 w-3.5" /> שגר סריקת עומק
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onNavigate("search")}>
                <Search className="h-3.5 w-3.5" /> חיפוש 5.5+
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Recent activity */}
        <motion.div custom={5} variants={fadeUp} initial="hidden" animate="show" className="lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-bold">
                  <Clock className="h-4 w-4" /> פעילות אחרונה
                </p>
                {runningHunt && (
                  <Badge className="gap-1 bg-amber-500/90 text-white">
                    <Loader2 className="h-3 w-3 animate-spin" /> ציד #{runningHunt.id} בשלב {runningHunt.stageKey}
                  </Badge>
                )}
              </div>
              {activity.length === 0 ? (
                <div className="rounded-xl border border-dashed p-8 text-center">
                  <p className="text-3xl">🏹</p>
                  <p className="mt-2 font-medium">עוד לא צדת אף צייד</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    התחל בחיפוש או בציד חי — הפעילות תתעדכן כאן בזמן אמת
                  </p>
                </div>
              ) : (
                <ul className="max-h-96 space-y-1 overflow-y-auto pr-1">{activity.map((a) => <li key={a.key}>{a.node}</li>)}</ul>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Doctrine / system panel */}
        <motion.div custom={6} variants={fadeUp} initial="hidden" animate="show">
          <Card className="h-full border-violet-200/70 bg-gradient-to-b from-violet-50/60 to-card dark:border-violet-900 dark:from-violet-950/20">
            <CardContent className="space-y-4 p-4">
              <p className="flex items-center gap-1.5 text-sm font-bold">
                <FlaskConical className="h-4 w-4 text-violet-600" /> דוקטרינת המערכת
              </p>
              <div className="space-y-2.5 text-xs leading-relaxed text-muted-foreground">
                <p className="flex gap-2">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>
                    <strong className="text-foreground">חוק ברזל:</strong> סף מודלים {THRESHOLD_LABEL} בלבד, נעול בקוד.{" "}
                    <span title={THRESHOLD_RULE_TEXT} className="cursor-help underline decoration-dotted">
                      משפחת 4.x חסומה בשרת, במסננים ובציון.
                    </span>
                  </span>
                </p>
                <p className="flex gap-2">
                  <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
                  <span>
                    <strong className="text-foreground">לולאת האבולוציה:</strong> כל משימה שמדווחת מהשדה מזוקקת לגן DNA חדש —
                    הספרייה מחכימה מכל הרצה.
                  </span>
                </p>
                <p className="flex gap-2">
                  <Swords className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
                  <span>
                    <strong className="text-foreground">שרשרת ההרג:</strong> hunt → swarm → attack → mine → compile → execute →
                    grow → verdict. שלב אחד לכל קריאה, resumable מכל נקודה.
                  </span>
                </p>
                {lastHunt && (
                  <p className="flex gap-2">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span>
                      <strong className="text-foreground">מסע האחרון:</strong> {fmtMs(lastHunt.elapsedMs)} · {lastHunt.llmCalls}{" "}
                      קריאות LLM · ספרייה {lastHunt.dnaBefore}
                      {lastHunt.dnaAfter > lastHunt.dnaBefore ? ` → ${lastHunt.dnaAfter}` : ""}
                    </span>
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-1.5"
                onClick={() => onNavigate("live")}
              >
                לחדר המלחמה <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
