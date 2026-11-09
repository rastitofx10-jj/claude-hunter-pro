"use client";

// ============================================================
// Mission Control — the sixth loop: execute → lessons → evolution
// Natural-language goal → automatic DNA retrieval → battle plan ready to run
// Field report → lesson distillation → new DNA is born — the library grows smarter with every mission
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Target,
  Loader2,
  Copy,
  Download,
  FileText,
  Send,
  RotateCcw,
  Trash2,
  Dna,
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  Sparkles,
  CircleDot,
  Play,
  Rocket,
  PackageOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { apiFetch, downloadFile } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";

// ---------- types ----------

interface SelectedDna {
  id: number;
  path: string;
  name: string;
  kind: string;
  sourceRepo: string;
  reason: string;
}
interface MissionPhase {
  title: string;
  objective: string;
  steps: string[];
  dnaUsed: string[];
  verify: string;
}
interface MissionPrompt {
  order: number;
  label: string;
  paste: string;
}
interface CompiledPayload {
  missionName: string;
  oneLiner: string;
  phases: MissionPhase[];
  promptSequence: MissionPrompt[];
  skillMd: string;
  skillMdSource?: "ai" | "fallback" | "unknown";
  risks: string[];
  successCriteria: string[];
  selectedDna: SelectedDna[];
}
interface MissionListItem {
  id: number;
  missionName: string;
  goal: string;
  status: string;
  oneLiner: string;
  phaseCount: number;
  promptCount: number;
  hasReport: boolean;
  createdAt: string;
}
interface MissionListResponse {
  items: MissionListItem[];
  /** Grand total in the DB — the heading used to show items.length (capped at 50) and the rest vanished */
  total?: number;
  stats: { totalDna: number; fieldDna: number };
}
interface MissionAutopilotFailure {
  phaseIndex: number;
  error: string;
}
interface MissionAutopilot {
  steps: { phaseIndex: number; title: string; deliverable: string; executedAt: string }[];
  failures: MissionAutopilotFailure[];
}
interface MissionDetail extends CompiledPayload {
  id: number;
  goal: string;
  context: string | null;
  status: string;
  report: { outcome: string; verdict: string; lessons: string[]; bornDnaId: number | null; reportedAt: string } | null;
  // Intentionally wide — the server sends verdict/notes/distillMethod on every report; a narrow type would
  // break history rendering (round 4: a lying type beats code that lies more).
  reportHistory?: Record<string, unknown>[];
  autopilot: MissionAutopilot | null;
  autopilotAt: string | null;
  createdAt: string;
  bundle: string;
}
interface StepResponse {
  done: boolean;
  allDone: boolean;
  executed: MissionAutopilot["steps"][number] | null;
  failure: MissionAutopilotFailure | null;
  stepsDone: number;
  totalPhases: number;
  autopilot: MissionAutopilot;
}
interface ReportResponse {
  ok: boolean;
  distillMethod?: "ai" | "local";
  verdict: string;
  lessons: string[];
  bornDna: { id: number | null; name?: string; description?: string; birthError?: string | null } | null;
  /** The actual status written on the server (per the precedence rule) — the client used to guess on its own and drift */
  finalStatus?: string;
  historyCount?: number;
}

// ---------- constants ----------

/** Defensive client-side normalization: broken/stale DB rows don't take down the tab
 * (before: .length/.map on fields the server promised in types but not at runtime) */
function normalizeDetail(d: MissionDetail): MissionDetail {
  const autopilot = d.autopilot
    ? {
        steps: Array.isArray(d.autopilot.steps)
          ? d.autopilot.steps.map((s) => ({
              phaseIndex: typeof s.phaseIndex === "number" ? s.phaseIndex : 0,
              title: typeof s.title === "string" ? s.title : `Phase ${(s.phaseIndex ?? 0) + 1}`,
              deliverable: typeof s.deliverable === "string" ? s.deliverable : "",
              executedAt: typeof s.executedAt === "string" ? s.executedAt : "",
            }))
          : [],
        failures: Array.isArray(d.autopilot.failures) ? d.autopilot.failures : [],
      }
    : null;
  const report =
    d.report && typeof d.report === "object"
      ? { ...d.report, lessons: Array.isArray(d.report.lessons) ? d.report.lessons : [] }
      : null;
  // Report history — defensive normalization like every other field (round 4: GET returns it,
  // POST returns []; now it's also rendered in the UI instead of being dead)
  const reportHistory = Array.isArray(d.reportHistory)
    ? d.reportHistory.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    : [];
  return {
    ...d,
    phases: Array.isArray(d.phases)
      ? d.phases.map((p) => ({
          ...p,
          steps: Array.isArray(p.steps) ? p.steps : [],
          dnaUsed: Array.isArray(p.dnaUsed) ? p.dnaUsed : [],
        }))
      : [],
    promptSequence: Array.isArray(d.promptSequence) ? d.promptSequence : [],
    risks: Array.isArray(d.risks) ? d.risks : [],
    successCriteria: Array.isArray(d.successCriteria) ? d.successCriteria : [],
    selectedDna: Array.isArray(d.selectedDna) ? d.selectedDna : [],
    autopilot,
    report,
    reportHistory,
  };
}

/** Short relative time for display in the history */
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US");
}

const EXAMPLE_GOALS = [
  "Build a web-search synthesis skill that produces a verified review with sources",
  "Upgrade our test process to autonomous in-browser E2E",
  "Design the architecture for a new AI module: caching, retries, and streaming flow",
];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  compiled: { label: "Compiled", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  in_progress: { label: "In progress", cls: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  done: { label: "Completed", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  partial: { label: "Partial", cls: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300" },
  failed: { label: "Failed", cls: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" },
};

const OUTCOME_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "success", label: "Full success", hint: "All success criteria passed" },
  { value: "partial", label: "Partial success", hint: "Some phases passed — there's room to fix" },
  { value: "failed", label: "Failed", hint: "We got stuck — but there are valuable lessons" },
];

// ---------- component ----------

export function MissionControlPanel() {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [outcome, setOutcome] = useState("success");
  const [notes, setNotes] = useState("");
  // Tracks the latest request id — a stale response for mission A won't overwrite B's view
  const detailReqRef = useRef(0);

  // ---------- queries ----------
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiFetch<MissionListResponse>("/api/mission", token),
  });

  // ---------- mutations ----------
  const compileM = useMutation({
    mutationFn: () =>
      apiFetch<MissionDetail>("/api/mission", token, {
        method: "POST",
        body: JSON.stringify({ goal: goal.trim(), context: context.trim() }),
      }),
    onSuccess: (raw) => {
      const data = normalizeDetail(raw); // POST returns exactly the same shape as GET
      setDetail(data);
      setGoal("");
      setContext("");
      void qc.invalidateQueries({ queryKey: ["missions"] });
      toast({
        title: "Mission compiled 🎯",
        description: `${data.missionName} · ${data.phases.length} phases · ${data.selectedDna.length} genes selected${data.skillMdSource === "fallback" ? " · SKILL.md: local fallback" : ""}`,
      });
    },
    onError: (e: Error) => toast({ title: "Compilation failed", description: e.message, variant: "destructive" }),
  });

  const statusM = useMutation({
    mutationFn: (p: { id: number; status: string }) =>
      apiFetch<{ id: number; status: string }>(`/api/mission/${p.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: p.status }),
      }),
    onSuccess: (data) => {
      setDetail((d) => (d && d.id === data.id ? { ...d, status: data.status } : d));
      void qc.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (e: Error) => toast({ title: "Status update failed", description: e.message, variant: "destructive" }),
  });

  const reportM = useMutation({
    mutationFn: (p: { missionId: number }) =>
      apiFetch<ReportResponse>("/api/mission/report", token, {
        method: "POST",
        body: JSON.stringify({ missionId: p.missionId, outcome, notes: notes.trim() }),
      }),
    onSuccess: (data, vars) => {
      setReportOpen(false);
      setNotes("");
      // Sync from the server instead of client-side prediction — the client used to compute the status on its own
      // (reporting failed on a done mission left "done" on the server but "failed" on screen,
      // and reportHistory was never appended).
      setDetail((d) =>
        d && d.id === vars.missionId
          ? { ...d, status: data.finalStatus ?? (outcome === "success" ? "done" : outcome) }
          : d
      );
      void qc.invalidateQueries({ queryKey: ["missions"] });
      void qc.invalidateQueries({ queryKey: ["dna-library"] });
      toast({
        title: data.bornDna ? (data.bornDna.id ? "Lessons distilled · new DNA born 🧬" : "Lessons distilled · DNA birth failed") : data.distillMethod === "local" ? "Report saved (AI distillation unavailable)" : "Lessons distilled ✅",
        description: data.bornDna ? (data.bornDna.id ? `Born: ${data.bornDna.name ?? ""} — the library grows smarter` : `${data.bornDna.birthError ?? "Birth error"} — the report was saved`) : data.verdict,
      });
    },
    onError: (e: Error) => toast({ title: "Report distillation failed", description: e.message, variant: "destructive" }),
  });

  // ---------- autopilot — stepping the run from the client ----------
  // Each call executes one phase on the server and immediately persists it to the DB —
  // a disconnect/restart loses nothing, and progress is visible phase by phase.
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotProgress, setAutopilotProgress] = useState("");
  // Cancel flag: if the panel unmounts mid-run (navigating to another tab) the loop won't call
  // setState after unmount. The flag used to be defined and checked, but nothing ever triggered it.
  const autopilotCancelRef = useRef(false);
  useEffect(() => {
    return () => {
      autopilotCancelRef.current = true;
    };
  }, []);

  const runAutopilot = async (id: number) => {
    if (autopilotRunning) return;
    setAutopilotRunning(true);
    autopilotCancelRef.current = false;
    // Fresh token from the store on every call — before: a closure stuck on a stale token
    const currentToken = useHunterStore.getState().token;
    let okSteps = 0;
    let failSteps = 0;
    let alreadyComplete = false;
    try {
      for (let guard = 0; guard < 12; guard++) {
        if (autopilotCancelRef.current) return; // cancelled — no toast and no setState
        setAutopilotProgress(`Executing phase ${okSteps + failSteps + 1}…`);
        const data = await apiFetch<StepResponse>(`/api/mission/${id}/autopilot/step`, currentToken, { method: "POST" });
        if (autopilotCancelRef.current) return;
        if (data.executed) okSteps++;
        if (data.failure) failSteps++;
        if (guard === 0 && data.done && !data.executed && !data.failure) {
          // The mission is already fully executed — not a failure. A destructive "run failed" toast used to show.
          alreadyComplete = true;
          break;
        }
        setAutopilotProgress(
          data.executed
            ? `Completed phase ${data.executed.phaseIndex + 1}/${data.totalPhases}: ${data.executed.title}`
            : data.failure
              ? `Phase ${data.failure.phaseIndex + 1} failed`
              : ""
        );
        setDetail((d) =>
          d && d.id === id ? { ...d, autopilot: data.autopilot, status: d.status === "compiled" ? "in_progress" : d.status } : d
        );
        if (data.allDone || data.done) break;
        if (!data.executed && !data.failure) break; // stuck — don't loop forever
      }
      toast({
        title: alreadyComplete ? "Mission already fully executed" : okSteps > 0 ? "Autopilot has landed 🚀" : "Run failed",
        description: alreadyComplete
          ? "No phases pending — ready to file a field report"
          : `${okSteps} phases executed successfully${failSteps > 0 ? ` · ${failSteps} failed` : ""} — deliverables saved`,
        variant: okSteps > 0 || alreadyComplete ? undefined : "destructive",
      });
    } catch (e) {
      // A mid-run disconnect loses nothing already saved — you can simply resume from the next phase
      toast({
        title: "Run stopped midway",
        description: `${e instanceof Error ? e.message : "Error"} — completed phases are saved; press again to resume`,
        variant: "destructive",
      });
    } finally {
      setAutopilotRunning(false);
      setAutopilotProgress("");
      // Full sync from the server — the client used to predict the status on its own and drift from the truth
      // (a run that ended in total failure left "in progress" on screen until a refresh).
      void loadDetail(id).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["missions"] });
    }
  };

  const deleteM = useMutation({
    mutationFn: (id: number) => apiFetch<{ ok: boolean }>(`/api/mission/${id}`, token, { method: "DELETE" }),
    onSuccess: (_d, id) => {
      setDetail((d) => (d?.id === id ? null : d));
      void qc.invalidateQueries({ queryKey: ["missions"] });
      toast({ title: "Mission deleted" });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const loadDetail = async (id: number) => {
    const reqId = ++detailReqRef.current;
    try {
      const d = await apiFetch<MissionDetail>(`/api/mission/${id}`, token);
      if (reqId !== detailReqRef.current) return; // stale response — a newer click is already in flight
      setDetail(normalizeDetail(d));
    } catch (e) {
      if (reqId !== detailReqRef.current) return;
      toast({ title: "Failed to load mission", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied 📋` });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const stats = listData?.stats;
  const items = useMemo(() => listData?.items ?? [], [listData]);

  return (
    <div className="space-y-5">
      {/* Evolution loop — status indicator */}
      <section className="rounded-xl border bg-gradient-to-l from-violet-50/70 via-background to-background p-4 dark:from-violet-950/20" aria-label="Evolution loop status indicator">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white shadow-sm">
              <RotateCcw className="h-4.5 w-4.5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-bold">Evolution Loop</p>
              <p className="text-xs text-muted-foreground">Run a mission → report from the field → lessons become new DNA → the library grows smarter</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="outline" className="gap-1 px-2.5 py-1">
              <Dna className="h-3.5 w-3.5" /> {stats?.totalDna ?? 0} genes in library
            </Badge>
            <Badge className="gap-1 border-emerald-300 bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              <Sparkles className="h-3.5 w-3.5" /> {stats?.fieldDna ?? 0} born from the field
            </Badge>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        {/* Compile & details column */}
        <div className="space-y-5 xl:col-span-2">
          {/* Compile form */}
          <section className="rounded-xl border bg-card p-4 shadow-sm" aria-label="Compile a new mission">
            <p className="mb-1 flex items-center gap-2 text-sm font-bold">
              <Target className="h-4 w-4 text-violet-600" /> Compile a New Mission
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Describe a goal in natural language — the engine picks the relevant DNA from the library on its own and assembles a battle plan + a prompt sequence ready to paste into Claude Code
            </p>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="For example: build a skill that searches the web, cross-checks sources, and produces a verified report…"
              className="mb-2 min-h-20 resize-y"
              maxLength={2000}
              aria-label="Mission goal"
            />
            <Input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Additional context (optional): stack, constraints, deadline…"
              className="mb-3 text-sm"
              maxLength={2000}
              aria-label="Additional context"
            />
            <div className="mb-3 flex flex-wrap gap-1.5">
              {EXAMPLE_GOALS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGoal(g)}
                  className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
                >
                  {g}
                </button>
              ))}
            </div>
            <Button
              onClick={() => compileM.mutate()}
              disabled={compileM.isPending || goal.trim().length < 8}
              className="w-full bg-violet-600 text-white hover:bg-violet-700 sm:w-auto"
            >
              {compileM.isPending ? (
                <>
                  <Loader2 className="ml-2 h-4 w-4 animate-spin" /> Assembling battle plan… (up to a minute)
                </>
              ) : (
                <>
                  <Play className="ml-2 h-4 w-4" /> Compile mission
                </>
              )}
            </Button>
          </section>

          {/* Active mission — details */}
          {detail && (
            <MissionDetailCard
              key={detail.id} // openSteps state doesn't leak between missions
              m={detail}
              onCopy={copyText}
              onStatus={(s) => statusM.mutate({ id: detail.id, status: s })}
              onReport={() => setReportOpen(true)}
              onDelete={() => {
                // Confirm before delete — a single click used to permanently delete the mission,
                // its deliverables and the report history (and now also the DNA born from it).
                if (window.confirm("Delete this mission?\nThis will also delete the DNA born from it and the report history — this cannot be undone.")) {
                  deleteM.mutate(detail.id);
                }
              }}
              onAutopilot={() => void runAutopilot(detail.id)}
              busy={statusM.isPending || deleteM.isPending}
              autopilotRunning={autopilotRunning}
              autopilotProgress={autopilotProgress}
            />
          )}
        </div>

        {/* History column */}
        <section className="rounded-xl border bg-card p-4 shadow-sm" aria-label="Past missions">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold">
            <ListChecks className="h-4 w-4 text-violet-600" /> Missions ({listData?.total ?? items.length})
          </p>
          {listLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              No missions yet. Compile a goal and start executing 🚀
            </div>
          ) : (
            <ul className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
              {items.map((it) => {
                const st = STATUS_META[it.status] ?? STATUS_META.compiled;
                return (
                  <li key={it.id}>
                    <button
                      onClick={() => void loadDetail(it.id)}
                      className={`w-full rounded-lg border p-3 text-right transition-colors hover:border-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-950/20 ${detail?.id === it.id ? "border-violet-500 bg-violet-50/60 dark:bg-violet-950/30" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span dir="ltr" className="truncate font-mono text-xs font-semibold text-violet-700 dark:text-violet-300">
                          {it.missionName}
                        </span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{it.goal}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                            <span>{it.phaseCount} phases</span>
                        <span>·</span>
                            <span>{it.promptCount} prompts</span>
                        {it.createdAt && (
                          <>
                            <span>·</span>
                            <span>{relTime(it.createdAt)}</span>
                          </>
                        )}
                        {it.hasReport && (
                          <>
                            <span>·</span>
                                <span className="font-semibold text-emerald-600 dark:text-emerald-400">Reported ✓</span>
                          </>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Field report dialog */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4 text-violet-600" /> Field Report — Feed the Loop
            </DialogTitle>
            <DialogDescription>
              Tell what actually happened. The distiller extracts lessons and births new DNA into the library — that's how the system improves with every mission.
            </DialogDescription>
          </DialogHeader>

          <RadioGroup value={outcome} onValueChange={setOutcome} className="my-2 grid gap-2">
            {OUTCOME_OPTIONS.map((o) => (
              <Label
                key={o.value}
                htmlFor={`outcome-${o.value}`}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${outcome === o.value ? "border-violet-500 bg-violet-50/60 dark:bg-violet-950/30" : "hover:bg-muted/40"}`}
              >
                <RadioGroupItem id={`outcome-${o.value}`} value={o.value} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-semibold">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.hint}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>

          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What worked? What broke? Which workaround bypassed the problem? Which prompt produced the best result?"
            className="min-h-24 resize-y"
            maxLength={4000}
            aria-label="Field notes"
          />

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReportOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => detail && reportM.mutate({ missionId: detail.id })}
              disabled={reportM.isPending}
              className="bg-violet-600 text-white hover:bg-violet-700"
            >
              {reportM.isPending ? (
                <>
                  <Loader2 className="ml-2 h-4 w-4 animate-spin" /> Distilling lessons…
                </>
              ) : (
                <>
                  <Send className="ml-2 h-4 w-4" /> Send & Distill
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Mission detail card ----------

function MissionDetailCard({
  m,
  onCopy,
  onStatus,
  onReport,
  onDelete,
  onAutopilot,
  busy,
  autopilotRunning,
  autopilotProgress,
}: {
  m: MissionDetail;
  onCopy: (text: string, what: string) => void;
  onStatus: (status: string) => void;
  onReport: () => void;
  onDelete: () => void;
  onAutopilot: () => void;
  busy: boolean;
  autopilotRunning: boolean;
  autopilotProgress: string;
}) {
  const st = STATUS_META[m.status] ?? STATUS_META.compiled;
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set());
  const toggleStep = (i: number) =>
    setOpenSteps((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  // Per-phase status: executed / failed / pending — from persisted data (accurate even after a restart)
  const executedMap = new Map((m.autopilot?.steps ?? []).map((s) => [s.phaseIndex, s]));
  const failedMap = new Map((m.autopilot?.failures ?? []).map((f) => [f.phaseIndex, f]));
  const totalPhases = m.phases.length;
  const stepsDone = executedMap.size;
  const stepsFailed = failedMap.size;
  const remaining = Math.max(0, totalPhases - stepsDone - stepsFailed);
  const hasPending = remaining > 0;
  return (
    <section className="rounded-xl border-2 border-violet-200 bg-card p-4 shadow-sm dark:border-violet-900" aria-label={`Mission ${m.missionName}`}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 dir="ltr" className="font-mono text-base font-bold text-violet-700 dark:text-violet-300">
              {m.missionName}
            </h3>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span>
            {m.skillMdSource === "fallback" && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300" title="AI generation of SKILL.md failed — the local fallback was used">
                SKILL.md: local fallback
              </span>
            )}
            {m.skillMdSource === "unknown" && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300" title={'A row compiled before source tagging existed — it used to show as AI by mistake'}>
                SKILL.md: source untagged
              </span>
            )}
          </div>
          {m.oneLiner && <p className="mt-1 text-sm font-medium">{m.oneLiner}</p>}
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">Goal: {m.goal}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => onCopy(m.bundle, "Mission bundle")} title="Copy the full bundle">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadFile(`mission-${m.missionName}.md`, m.bundle, "text/markdown")}
            title="Download the mission bundle"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={onDelete} disabled={busy} title="Delete the mission" className="text-rose-600 hover:text-rose-700">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Auto-selected DNA */}
      {m.selectedDna.length > 0 && (
        <div className="mt-3 rounded-lg bg-violet-50/60 p-3 dark:bg-violet-950/20">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-violet-700 dark:text-violet-300">
            <Dna className="h-3.5 w-3.5" /> Auto-selected from the library ({m.selectedDna.length})
          </p>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {m.selectedDna.map((d) => (
              <Badge key={d.id} variant="outline" className="max-w-full gap-1 bg-background text-[10px] font-normal">
                <span dir="ltr" className="truncate font-mono">{d.name}</span>
                <span className="shrink-0 text-muted-foreground">· {d.sourceRepo.split("/").pop()}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Phases — with live execution status */}
      <div className="mt-4 space-y-2">
        <p className="text-xs font-bold text-muted-foreground">Mission Phases</p>
        {m.phases.map((p, i) => {
          const done = executedMap.has(i);
          const failed = failedMap.has(i);
          return (
          <div key={i} className={`rounded-lg border p-3 ${done ? "border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/10" : failed ? "border-rose-300 bg-rose-50/40 dark:border-rose-800 dark:bg-rose-950/10" : ""}`}>
            <div className="flex items-center gap-2">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${done ? "bg-emerald-600" : failed ? "bg-rose-600" : "bg-violet-600"}`}>
                {done ? "✓" : failed ? "✗" : i + 1}
              </span>
              <p className="text-sm font-bold">{p.title}</p>
              {autopilotRunning && !done && !failed && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />}
            </div>
            {failed && failedMap.get(i) && (
              <p className="mt-1 pr-8 text-xs font-medium text-rose-700 dark:text-rose-300">Failure: {failedMap.get(i)!.error}</p>
            )}
            {p.objective && <p className="mt-1 pr-8 text-xs text-muted-foreground">{p.objective}</p>}
            {p.steps.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 pr-8">
                {p.steps.map((s, j) => (
                  <li key={j} className="flex items-start gap-1.5 text-xs">
                    <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1.5 pr-8 text-[10px]">
              {p.dnaUsed.length > 0 && (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  🧬 {p.dnaUsed.join(" · ")}
                </span>
              )}
              {p.verify && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  ✓ Verify: {p.verify}
                </span>
              )}
            </div>
          </div>
          );
        })}
      </div>

      {/* Prompt sequence */}
      {m.promptSequence.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-bold text-muted-foreground">Prompt Sequence — paste into Claude Code in order</p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {m.promptSequence.map((p) => (
              <div key={p.order} className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold">
                    <span className="text-violet-600">{p.order}.</span> {p.label}
                  </p>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onCopy(p.paste, "Prompt")}>
                      <Copy className="h-3 w-3" /> Copy
                  </Button>
                </div>
                <pre dir="ltr" className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-background p-2 text-left font-mono text-[11px] leading-relaxed">
                  {p.paste}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Risks & criteria */}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {m.risks.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Risks & Mitigation
            </p>
            <ul className="space-y-1 text-xs">
              {m.risks.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        )}
        {m.successCriteria.length > 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/20">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Success Criteria
            </p>
            <ul className="space-y-1 text-xs">
              {m.successCriteria.map((c, i) => (
                <li key={i}>• {c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Autopilot — autonomous deliverables */}
      {(autopilotRunning || m.autopilot) && (
        <div className="mt-4 rounded-lg border-2 border-amber-300 bg-gradient-to-b from-amber-50/70 to-background p-3 dark:border-amber-800 dark:from-amber-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-bold text-amber-700 dark:text-amber-300">
              <Rocket className="h-4 w-4" />
              {autopilotRunning
                ? "Autopilot is flying — every phase is saved the moment it completes"
                : `Autonomous flight deliverables (${stepsDone}/${totalPhases} phases)`}
            </p>
            {m.autopilot && !autopilotRunning && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() => {
                  const all = m.autopilot!.steps.map((s, i) => `\n\n---\n\n# Phase ${i + 1}: ${s.title}\n\n${s.deliverable}`).join("");
                  downloadFile(`autopilot-${m.missionName}.md`, `# Autopilot Deliverables — ${m.missionName}\n\nGoal: ${m.goal}${all}`, "text/markdown");
                }}
              >
                <Download className="h-3 w-3" /> Download all deliverables
              </Button>
            )}
          </div>
          {/* Real progress bar — from persisted data */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950">
              <div
                className="h-full rounded-full bg-gradient-to-l from-amber-500 to-orange-600 transition-all duration-500"
                style={{ width: `${totalPhases > 0 ? Math.round(((stepsDone + stepsFailed) / totalPhases) * 100) : 0}%` }}
                role="progressbar"
                aria-valuenow={stepsDone + stepsFailed}
                aria-valuemin={0}
                aria-valuemax={totalPhases}
              />
            </div>
            <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">
              {stepsDone}✓ · {stepsFailed}✗ · {remaining} pending
            </span>
          </div>
          {autopilotRunning && (
            <div className="mt-2 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {autopilotProgress || "Executing the next phase with the selected DNA + Handoff chaining…"}
            </div>
          )}
          {m.autopilot && (
            <div className="mt-2 space-y-2">
              {m.autopilot.steps.map((s, i) => (
                <div key={i} className="rounded-md border bg-background p-2.5">
                  <button onClick={() => toggleStep(i)} className="flex w-full items-center justify-between gap-2 text-right">
                    <span className="flex items-center gap-2 text-xs font-bold">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">{s.phaseIndex + 1}</span>
                      {s.title}
                      <span className="font-normal text-muted-foreground">· {Math.round(s.deliverable.length / 100) / 10}k chars</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">{openSteps.has(i) ? "▲" : "▼"}</span>
                  </button>
                  {openSteps.has(i) && (
                    <pre dir="ltr" className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 p-2.5 text-left font-mono text-[11px] leading-relaxed">
                      {s.deliverable}
                    </pre>
                  )}
                </div>
              ))}
              {m.autopilot.failures.length > 0 && (
                <div className="rounded-md border border-rose-300 bg-rose-50/60 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                  <p className="font-bold">Partial failures:</p>
                  <ul className="mt-1 space-y-0.5">
                    {m.autopilot.failures.map((f) => (
                      <li key={f.phaseIndex}>• Phase {f.phaseIndex + 1}: {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!autopilotRunning && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  <PackageOpen className="ml-1 inline h-3 w-3" />
                  The deliverables are real: code, decisions, and Handoffs written by the execution unit with the library's DNA. Report from the field to turn lessons into lasting DNA.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Existing field report */}
      {m.report && (
        <div className="mt-4 rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-800 dark:bg-emerald-950/30">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300">
            <Sparkles className="h-3.5 w-3.5" /> {m.report.verdict}
          </p>
          <ul className="space-y-0.5 text-xs">
            {m.report.lessons.map((l, i) => (
              <li key={i}>• {l}</li>
            ))}
          </ul>
          {m.report.bornDnaId && (
            <p className="mt-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              🧬 This lesson was immortalized as a new capability in the library (#{m.report.bornDnaId}) — already available in the next mission compilation
            </p>
          )}
        </div>
      )}

      {/* Report history — it used to arrive from the server but was never displayed */}
      {(m.reportHistory?.length ?? 0) > 1 && (
        <div className="mt-3 rounded-lg border bg-muted/30 p-3">
          <p className="mb-1.5 text-xs font-bold text-muted-foreground">Report History ({m.reportHistory!.length})</p>
          <ol className="space-y-1.5 border-r-2 border-muted pr-3">
            {m.reportHistory!.map((r, i) => {
              const outcome = typeof r.outcome === "string" ? r.outcome : "?";
              const verdict = typeof r.verdict === "string" ? r.verdict : "";
              const reportedAt = typeof r.reportedAt === "string" ? new Date(r.reportedAt).toLocaleString("en-US") : "";
              const tone =
                outcome === "success"
                  ? "bg-emerald-600"
                  : outcome === "partial"
                    ? "bg-orange-500"
                    : "bg-rose-600";
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {outcome === "success" ? "Success" : outcome === "partial" ? "Partial" : "Failure"}
                    </span>
                    {reportedAt && <span className="text-muted-foreground"> · {reportedAt}</span>}
                    {verdict && (
                      <span className="block text-muted-foreground" dir="auto">
                        {verdict}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Bottom actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          onClick={onAutopilot}
          disabled={busy || autopilotRunning}
          className="bg-gradient-to-l from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
        >
          {autopilotRunning ? (
            <>
              <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> Flying autonomously…
            </>
          ) : (
            <>
              <Rocket className="ml-1 h-3.5 w-3.5" />
              {hasPending && (m.autopilot || m.status === "in_progress") ? `Resume flight (${remaining} phases left)` : "Launch autopilot"}
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || m.status === "done"}
          onClick={() => onStatus("in_progress")}
          title={m.status === "done" ? "A completed mission has a locked status" : "Mark the mission as in progress"}
        >
          <Play className="ml-1 h-3.5 w-3.5" /> Mark in progress
        </Button>
        <Button size="sm" onClick={onReport} disabled={busy} className="bg-violet-600 text-white hover:bg-violet-700">
          <Send className="ml-1 h-3.5 w-3.5" /> Report from the field
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCopy(m.skillMd, "SKILL.md")} className="text-xs">
          <FileText className="ml-1 h-3.5 w-3.5" /> Copy SKILL.md
        </Button>
      </div>
    </section>
  );
}
