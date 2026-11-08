"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Swords,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  RotateCcw,
  Clock,
  Dna,
  Target,
  ChevronDown,
  Zap,
  History,
  Brain,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { useHunterStore } from "@/lib/hunter-store";
import { apiFetch } from "@/lib/api-client";

// ---------- types (single source: the API route returns all of these) ----------

interface StageRecord {
  key: string;
  title: string;
  summary: string;
  ms: number;
  evidence: Record<string, unknown>;
}

interface HuntState {
  id: number;
  status: string;
  stageKey: string;
  done: boolean;
  goal: string;
  missionId: number | null;
  generation: number;
  seededFrom: number | null;
  dnaBefore: number;
  dnaAfter: number;
  llmCalls: number;
  elapsedMs: number;
  error: string | null;
  stages: StageRecord[];
  stageOrder: readonly string[];
}

interface HuntListItem {
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
}

interface HuntResponse {
  hunt?: HuntState;
  items?: HuntListItem[];
  stageOrder?: readonly string[];
  stageTitles?: Record<string, string>;
  error?: string;
}

/** שגיאה שנזרקה מ-apiFetch ונושאת את גוף התשובה (payload.hunt) — ראה api-client.ts */
interface FetchErrorWithPayload extends Error {
  payload?: HuntResponse;
}

const STATUS_ICON: Record<string, string> = {
  hunt: "🛰️",
  swarm: "🐝",
  attack: "⚔️",
  mine: "⛏️",
  compile: "🧠",
  execute: "🤖",
  grow: "🧬",
  verdict: "📊",
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

// ---------- smart evidence renderer ----------

function clip(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function EvidenceChip({ label, value }: { label: string; value: string }) {
  return (
    <Badge variant="secondary" className="max-w-full gap-1 py-1 font-normal" dir="auto">
      <span className="font-semibold opacity-70">{label}:</span>
      <span className="truncate">{value}</span>
    </Badge>
  );
}

function EvidenceView({ evidence }: { evidence: Record<string, unknown> }) {
  const chips: { label: string; value: string }[] = [];
  const lists: { label: string; items: string[] }[] = [];
  const raws: { label: string; json: string }[] = [];

  const flatten = (obj: Record<string, unknown>, prefix = "", depth = 0) => {
    if (depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      const label = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) continue;
      if (typeof v === "boolean") {
        chips.push({ label, value: v ? "כן" : "לא" });
      } else if (typeof v === "number") {
        chips.push({ label, value: String(v) });
      } else if (typeof v === "string") {
        if (v.length <= 120) chips.push({ label, value: v });
        else raws.push({ label, json: v });
      } else if (Array.isArray(v)) {
        if (v.length === 0) {
          chips.push({ label, value: "0" });
        } else if (v.every((x) => typeof x === "string" || typeof x === "number")) {
          lists.push({ label, items: v.map((x) => clip(String(x), 110)).slice(0, 12) });
        } else {
          try {
            const items = v.slice(0, 6).map((item) => clip(JSON.stringify(item), 180));
            lists.push({ label, items });
          } catch {
            raws.push({ label, json: clip(JSON.stringify(v), 400) });
          }
        }
      } else if (typeof v === "object") {
        try {
          const entries = Object.entries(v as Record<string, unknown>);
          if (entries.every(([, x]) => typeof x === "string" || typeof x === "number")) {
            flatten(v as Record<string, unknown>, label, depth + 1);
          } else {
            raws.push({ label, json: clip(JSON.stringify(v), 500) });
          }
        } catch {
          // skip
        }
      }
    }
  };

  try {
    flatten(evidence);
  } catch {
    raws.push({ label: "raw", json: clip(JSON.stringify(evidence), 500) });
  }

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.slice(0, 18).map((c, i) => (
            <EvidenceChip key={`${c.label}-${i}`} label={c.label} value={c.value} />
          ))}
        </div>
      )}
      {lists.map((l, i) => (
        <div key={`${l.label}-${i}`} className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">{l.label}</p>
          <ul className="space-y-0.5 border-r-2 border-muted pr-3">
            {l.items.map((item, j) => (
              <li key={j} className="text-xs leading-relaxed text-foreground/80" dir="auto">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {raws.map((r, i) => (
        <div key={`${r.label}-${i}`} className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">{r.label}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed" dir="ltr">
            {r.json}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ---------- stage rail (the war-room heart) ----------

type StageVisual = "done" | "active" | "failed" | "pending";

function StageRail({
  order,
  titles,
  doneMap,
  currentKey,
  failed,
}: {
  order: readonly string[];
  titles: Record<string, string>;
  doneMap: Map<string, StageRecord>;
  currentKey: string | null;
  failed: boolean;
}) {
  return (
    <div className="overflow-x-auto pb-1" aria-label="צינור השלבים">
      <ol className="flex min-w-max items-center gap-0 px-1">
        {order.map((key, idx) => {
          const rec = doneMap.get(key) ?? null;
          const isCurrent = currentKey === key;
          const visual: StageVisual = failed && isCurrent ? "failed" : rec ? "done" : isCurrent ? "active" : "pending";
          const last = idx === order.length - 1;
          return (
            <li key={key} className="flex items-center">
              <div className="flex w-24 flex-col items-center gap-1.5 text-center sm:w-28">
                <div
                  className={`relative flex h-11 w-11 items-center justify-center rounded-full border-2 transition-all ${
                    visual === "done"
                      ? "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                      : visual === "active"
                        ? "border-amber-500 bg-amber-500/15 text-amber-600 shadow-[0_0_20px_-4px] shadow-amber-400/50 dark:text-amber-300"
                        : visual === "failed"
                          ? "border-red-500 bg-red-500/15 text-red-600 dark:text-red-300"
                          : "border-border text-muted-foreground/50"
                  }`}
                >
                  <span className="text-lg leading-none">{STATUS_ICON[key] ?? "•"}</span>
                  {visual === "done" && <CheckCircle2 className="absolute -bottom-1 -start-1 h-4 w-4 rounded-full bg-background text-emerald-500" />}
                  {visual === "active" && <Loader2 className="absolute -bottom-1 -start-1 h-4 w-4 animate-spin rounded-full bg-background text-amber-500" />}
                  {visual === "failed" && <XCircle className="absolute -bottom-1 -start-1 h-4 w-4 rounded-full bg-background text-red-500" />}
                </div>
                <p className={`text-[11px] font-semibold leading-tight ${visual === "pending" ? "text-muted-foreground/60" : "text-foreground"}`}>
                  {titles[key] ?? key}
                </p>
                {rec && <span className="text-[10px] tabular-nums text-muted-foreground">{fmtMs(rec.ms)}</span>}
                {visual === "active" && <span className="text-[10px] font-medium text-amber-600 dark:text-amber-300">מתבצע כעת</span>}
              </div>
              {!last && (
                <div
                  className={`mx-1 h-0.5 w-8 rounded sm:w-12 ${
                    doneMap.has(key) ? "bg-emerald-500/70" : "bg-border"
                  }`}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------- stage card ----------

function StageCard({ stageKey, title, visual, rec }: { stageKey: string; title: string; visual: StageVisual; rec: StageRecord | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      className={
        visual === "failed"
          ? "border-red-400/60"
          : visual === "active"
            ? "border-amber-400/70 shadow-[0_0_18px_-4px] shadow-amber-400/40"
            : visual === "done"
              ? "border-emerald-400/40"
              : "opacity-60"
      }
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="text-lg leading-none">{STATUS_ICON[stageKey] ?? "•"}</span>
            {visual === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
            {visual === "active" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />}
            {visual === "failed" && <XCircle className="h-4 w-4 shrink-0 text-red-500" />}
            {visual === "pending" && <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" dir="auto">
                {title}
              </p>
              {rec && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" dir="auto">
                  {rec.summary}
                </p>
              )}
            </div>
          </div>
          {rec && (
            <Badge variant="outline" className="shrink-0 gap-1 text-[11px]">
              <Clock className="h-3 w-3" />
              {fmtMs(rec.ms)}
            </Badge>
          )}
        </div>

        {rec && rec.evidence && Object.keys(rec.evidence).length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 px-2 text-xs text-muted-foreground">
                <Zap className="h-3 w-3" />
                ראיות ({Object.keys(rec.evidence).length} שדות)
                <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Separator className="mb-2" />
              <EvidenceView evidence={rec.evidence} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- the panel ----------

export function LiveHuntPanel() {
  const queryClient = useQueryClient();
  const token = useHunterStore((s) => s.token);
  const setActiveTab = useHunterStore((s) => s.setActiveTab);
  const [hunt, setHunt] = useState<HuntState | null>(null);
  const pumpingRef = useRef(false);
  const [autoPilot, setAutoPilot] = useState(true);
  // כותרות שלבים שהגיעו בתשובות start/next/retry — ממלאות את המסלול עוד לפני שרשימת
  // ההיסטוריה נטענה (בעבר: מפתחות אנגלית גולמיים הופיעו ברגע הראשון אחרי "התחל")
  const [respTitles, setRespTitles] = useState<Record<string, string>>({});

  const listQuery = useQuery({
    queryKey: ["live-hunt-list"],
    queryFn: () => apiFetch<HuntResponse>("/api/live-hunt", token),
  });

  const applyResponse = useCallback((data: HuntResponse) => {
    if (data.hunt) setHunt(data.hunt);
    if (data.stageTitles) setRespTitles((prev) => ({ ...prev, ...data.stageTitles! }));
    // data.error ב-2xx אינו קורה לעולם — apiFetch זורק חריגה לפני שמגיעים לכאן (הערה בלבד; הוסר בניקוי 2026-11)
  }, []);

  const startMutation = useMutation({
    mutationFn: () =>
      apiFetch<HuntResponse>("/api/live-hunt", token, {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      }),
    onSuccess: (data) => {
      applyResponse(data);
      void queryClient.invalidateQueries({ queryKey: ["live-hunt-list"] });
    },
    onError: (e: Error) => {
      toast({ title: "פתיחת הציד נכשלה", description: e.message, variant: "destructive" });
    },
  });

  const stepMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<HuntResponse>("/api/live-hunt", token, {
        method: "POST",
        body: JSON.stringify({ action: "next", id }),
      }),
    onSuccess: (data) => {
      applyResponse(data);
      pumpingRef.current = false;
    },
    onError: (e: Error) => {
      pumpingRef.current = false;
      // לב התיקון: השרת מצרף את מצב הציד הכושל בגוף התשובה (payload.hunt).
      // בעבר: המשאבה לא ראתה אותו, המצב נשאר "running" והיא המשיכה להצית את
      // השלב הכושל בלולאה אינסופית — שריפת מכסת GitHub/LLM ללא השגחה.
      const failedHunt = (e as FetchErrorWithPayload).payload?.hunt;
      if (failedHunt) setHunt(failedHunt);
      toast({ title: "שלב נכשל — אפשר לנסות שוב", description: e.message, variant: "destructive" });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<HuntResponse>("/api/live-hunt", token, {
        method: "POST",
        body: JSON.stringify({ action: "retry", id }),
      }),
    onSuccess: (data) => {
      applyResponse(data);
      void queryClient.invalidateQueries({ queryKey: ["live-hunt-list"] });
    },
    onError: (e: Error) => {
      const failedHunt = (e as FetchErrorWithPayload).payload?.hunt;
      if (failedHunt) setHunt(failedHunt);
      toast({ title: "הניסיון החוזר נכשל", description: e.message, variant: "destructive" });
    },
  });

  // המשאבה האוטומטית: כל עוד הציד רץ — מדליק את השלב הבא אחרי השהיה קצרה
  useEffect(() => {
    if (!autoPilot) return;
    if (!hunt || hunt.status !== "running") return;
    if (pumpingRef.current || stepMutation.isPending) return;
    const t = setTimeout(() => {
      if (pumpingRef.current) return;
      pumpingRef.current = true;
      stepMutation.mutate(hunt.id);
    }, 700);
    return () => clearTimeout(t);
  }, [hunt, autoPilot, stepMutation]);

  const loadHunt = useCallback(
    async (id: number) => {
      try {
        const res = await apiFetch<HuntResponse>(`/api/live-hunt?id=${id}`, token);
        applyResponse(res);
      } catch (e) {
        toast({ title: "טעינת הציד נכשלה", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      }
    },
    [applyResponse, token]
  );

  const stageOrder: readonly string[] = hunt?.stageOrder ?? listQuery.data?.stageOrder ?? [];
  const titles: Record<string, string> = { ...(listQuery.data?.stageTitles ?? {}), ...respTitles };
  const items = listQuery.data?.items ?? [];

  // (ממוקם אחרי ההצהרות של items/loadHunt — בעבר היה לפניהן וקרא משתנה ב-TDZ)
  // בעבר: המשתמש ראה כפתור "התחל" פנוי שהחזיר 409 עד שלחץ ידנית על השורה בהיסטוריה.
  useEffect(() => {
    if (hunt) return; // המשתמש כבר בחר ציד לתצוגה
    const active = items.find((i) => i.status === "running");
    if (!active) return;
    // דחייה ל-microtask — setState ישיר מתוך אפקט אסור (react-hooks/set-state-in-effect)
    const t = setTimeout(() => {
      void loadHunt(active.id);
    }, 0);
    return () => clearTimeout(t);
  }, [items, hunt, loadHunt]);

  const doneKeys = new Map<string, StageRecord>();
  for (const s of hunt?.stages ?? []) doneKeys.set(s.key, s);

  const failed = hunt?.status === "failed";
  const running = hunt?.status === "running";
  const finished = hunt?.status === "done";
  const bornDna = hunt && hunt.dnaAfter > hunt.dnaBefore ? hunt.dnaAfter - hunt.dnaBefore : 0;
  const hasRailData = stageOrder.length > 0;

  return (
    <div className="space-y-5" dir="rtl">
      {/* ---------- hero ---------- */}
      <Card className="border-primary/30 bg-gradient-to-bl from-orange-500/10 via-transparent to-transparent">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Swords className="h-5 w-5 text-primary" />
            ציד חי — חדר המלחמה
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            לחיצה אחת. המערכת צדה לבד ב-GitHub, שופטת מועמדים בלהקת פרומפטים, כורה DNA חי מהמטרות, מהדרת משימה
            מהגנים החדשים, מבצעת אותה אוטונומית, מזקקת את לקחי השדה לגן חדש — ומסכמת בראיות מלאות.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || running}
              className="gap-2 bg-gradient-to-l from-orange-600 to-amber-500 text-white hover:from-orange-700 hover:to-amber-600"
            >
              {startMutation.isPending || running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {running ? "הציד רץ — מתקדם לבד" : "התחל ציד חי אוטונומי"}
            </Button>
            {failed && hunt && (
              <Button variant="destructive" onClick={() => retryMutation.mutate(hunt.id)} className="gap-2">
                <RotateCcw className="h-4 w-4" />
                נסה שוב מהשלב הנוכחי
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoPilot((v) => !v)}
              className="gap-1.5"
              title="המשאבה האוטומטית ממשיכה לשלב הבא לבד"
            >
              {autoPilot ? <Zap className="h-3.5 w-3.5 text-amber-500" /> : <Circle className="h-3.5 w-3.5" />}
              {autoPilot ? "משאבה אוטומטית: פועלת" : "משאבה אוטומטית: כבויה"}
            </Button>
          </div>
          {hunt && !finished && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">ציד #{hunt.id}</Badge>
              {hunt.generation > 1 ? (
                <Badge className="gap-1 bg-amber-500/90 text-white">
                  <Dna className="h-3 w-3" /> דור {hunt.generation} — זריעה מציד #{hunt.seededFrom}
                </Badge>
              ) : (
                <Badge variant="secondary">דור 1 — ארסנל בסיסי</Badge>
              )}
              {hunt.goal && (
                <span className="max-w-full truncate" dir="auto">
                  🎯 {hunt.goal}
                </span>
              )}
            </div>
          )}
          {failed && hunt?.error && (
            <div className="rounded-md border border-red-300/60 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400" dir="auto">
              <span className="font-semibold">כשל: </span>
              {hunt.error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- the stage rail ---------- */}
      {hasRailData && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-sm font-bold">
                <Zap className="h-4 w-4 text-amber-500" /> שרשרת ההרג — {stageOrder.length} שלבים
              </p>
              {hunt && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{doneKeys.size}/{stageOrder.length}</span>
                  <span>הושלמו</span>
                </div>
              )}
            </div>
            <StageRail order={stageOrder} titles={titles} doneMap={doneKeys} currentKey={running ? (hunt?.stageKey ?? null) : null} failed={failed} />
          </CardContent>
        </Card>
      )}

      {/* ---------- campaign summary ---------- */}
      {finished && hunt && (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
          <Card className="border-emerald-400/50 bg-emerald-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-5 w-5 text-emerald-500" />
                מסקנת מערכה — ציד #{hunt.id} הושלם
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Dna className="h-3 w-3" /> צמיחת ספרייה
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums">
                  {hunt.dnaBefore} <span className="text-xs font-normal">→</span> {hunt.dnaAfter}
                </p>
                {bornDna > 0 && <Badge className="mt-1 bg-emerald-500 text-white">+{bornDna} גנים נולדו 🧬</Badge>}
              </div>
              <div className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Brain className="h-3 w-3" /> קריאות LLM
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums">{hunt.llmCalls}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Clock className="h-3 w-3" /> זמן מצטבר
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums">{fmtMs(hunt.elapsedMs)}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Target className="h-3 w-3" /> משימה שנוצרה
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums">#{hunt.missionId ?? "—"}</p>
                {hunt.missionId && (
                  <Button variant="link" size="sm" className="mt-1 h-6 p-0 text-xs" onClick={() => setActiveTab("mission")}>
                    פתח במבצעים ←
                  </Button>
                )}
              </div>
              {hunt.goal && (
                <div className="col-span-2 rounded-lg border p-3 sm:col-span-4">
                  <p className="text-[11px] text-muted-foreground">המטרה שנגזרה אוטומטית</p>
                  <p className="mt-1 text-sm leading-relaxed" dir="auto">
                    {hunt.goal}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ---------- stage cards (done stages, newest first visible) ---------- */}
      {hasRailData && (
        <div className="space-y-2.5">
          {stageOrder.map((key) => {
            const rec = doneKeys.get(key) ?? null;
            const isCurrent = hunt?.stageKey === key && running;
            // שלב חוזר (execute) חייב להראות "פעיל" כשהוא באמצע ריצה — בעבר הרשומה
            // מהפעם הקודמת ניצחה (rec ? done) והצינור הראה וי לא ירוק בזמן שהמשימה באוויר.
            const visual: StageVisual = failed && hunt?.stageKey === key ? "failed" : isCurrent ? "active" : rec ? "done" : "pending";
            if (!rec && !isCurrent && !(failed && hunt?.stageKey === key)) return null; // רק שלבים רלוונטיים — לא 8 כרטיסים אפורים
            return <StageCard key={key} stageKey={key} title={titles[key] ?? key} visual={visual} rec={rec} />;
          })}
        </div>
      )}

      {/* ---------- history ---------- */}
      {items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4" /> צידים קודמים
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72">
              <div className="space-y-1.5">
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => void loadHunt(item.id)}
                    className="flex w-full flex-wrap items-center gap-2 rounded-lg border p-2.5 text-start transition-colors hover:bg-muted/50"
                  >
                    <span className="text-xs font-semibold">#{item.id}</span>
                    {item.generation > 1 && (
                      <Badge variant="secondary" className="text-[10px]">
                        דור {item.generation}
                      </Badge>
                    )}
                    {item.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                    {item.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                    {item.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />}
                    <Badge variant="outline" className="text-[10px]">
                      {item.stagesCount} שלבים
                    </Badge>
                    {item.dnaAfter > item.dnaBefore && (
                      <Badge className="bg-emerald-500 text-white text-[10px]">+{item.dnaAfter - item.dnaBefore} DNA</Badge>
                    )}
                    {item.missionId && (
                      <Badge variant="secondary" className="text-[10px]">
                        משימה #{item.missionId}
                      </Badge>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="auto">
                      {item.goal || item.error || "—"}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70">{fmtMs(item.elapsedMs)}</span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
