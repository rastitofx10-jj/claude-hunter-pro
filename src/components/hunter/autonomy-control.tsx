"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { Bot, Loader2, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { useHydrated } from "@/hooks/use-hydrated";

// ============================================================
// The autonomy switch — opts the SERVER into the daily
// intelligence cycle (harvest + deep sweep, once a day, run by
// the scheduler with NO browser involved).
//
// GET  /api/settings/autonomy → { mode, lastCycleAt, nextCycleAt }
// POST { mode }   → flips the switch
// POST { trigger } → fires the cycle now (human kick)
//
// The switch is optimistic: the cache flips immediately, a
// failure rolls it back (invalidate) and explains itself.
// The SSE "autonomy" events invalidate the same ["autonomy"]
// query, so a cycle that fires server-side updates this card
// live even with the Insights tab closed.
// ============================================================

interface AutonomyInfo {
  mode: "off" | "daily";
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  triggered?: boolean;
  note?: string;
  /** Round 14: a harvest+sweep cycle is executing right now — disable the
   * trigger and show live state instead of letting a second click silently
   * no-op (which reads as "failed to launch"). */
  cycleInFlight?: boolean;
  /** "cycle" = the cycle function itself is running; "sweep" = the previous
   * cycle's sweep is still in flight. Either way the trigger honestly refuses. */
  blockedBy?: "cycle" | "sweep" | null;
}

function parseable(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function AutonomyControl() {
  const token = useHunterStore((s) => s.token);
  const mounted = useHydrated();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["autonomy"],
    queryFn: () => apiFetch<AutonomyInfo>("/api/settings/autonomy", token),
    enabled: mounted,
    staleTime: 30_000,
    // Round 14: while a cycle (or its sweep) is executing, poll fast — the card
    // flips back to "off — manual only" the moment the state lands (the SSE
    // invalidation also fires, but the poll covers a browser that missed it).
    refetchInterval: (query) => (query.state.data?.blockedBy ? 5_000 : 30_000),
  });

  const modeM = useMutation({
    mutationFn: (mode: "off" | "daily") =>
      apiFetch<AutonomyInfo>("/api/settings/autonomy", token, {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: ["autonomy"] });
      const prev = qc.getQueryData<AutonomyInfo>(["autonomy"]);
      qc.setQueryData<AutonomyInfo>(["autonomy"], (old) =>
        old ? { ...old, mode, nextCycleAt: mode === "off" ? null : old.nextCycleAt } : old,
      );
      return { prev };
    },
    onError: (e: Error, _mode, ctx) => {
      if (ctx?.prev) qc.setQueryData(["autonomy"], ctx.prev);
      toast.error("Autonomy update failed", { description: e.message });
    },
    // always resync with the server's truth (it recomputes nextCycleAt)
    onSettled: () => void qc.invalidateQueries({ queryKey: ["autonomy"] }),
  });

  const triggerM = useMutation({
    mutationFn: () =>
      apiFetch<AutonomyInfo>("/api/settings/autonomy", token, {
        method: "POST",
        body: JSON.stringify({ trigger: true }),
      }),
    onSuccess: (d) => {
      // Round 14: an in-flight rejection is NOT an error — it is the honest
      // "already running" answer. Anything else is the usual success note.
      if (d.triggered === false) {
        toast.info("A cycle is already running", { description: d.note });
      } else {
        toast.success(d.note ?? "The autonomous cycle is starting");
      }
      // Seed the cache with the returned truth so the button disables immediately
      // (before the 5s poll would pick it up).
      void qc.setQueryData<AutonomyInfo>(["autonomy"], (old) =>
        old
          ? {
              ...old,
              cycleInFlight: d.cycleInFlight ?? false,
              blockedBy: d.triggered === false ? (d.blockedBy ?? "cycle") : (old.blockedBy ?? "cycle"),
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
    onError: (e: Error) => toast.error("Could not trigger the cycle", { description: e.message }),
  });

  const daily = data?.mode === "daily";
  const last = parseable(data?.lastCycleAt);
  const next = parseable(data?.nextCycleAt);
  const blocked = data?.blockedBy === "cycle" || data?.blockedBy === "sweep";
  const inFlight = data?.blockedBy === "cycle";
  const sweepHold = data?.blockedBy === "sweep";
  const busy = modeM.isPending || triggerM.isPending;

  return (
    <Card className="border-amber-200/70 bg-gradient-to-b from-amber-50/50 to-card dark:border-amber-900 dark:from-amber-950/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-5 w-5 text-amber-600" aria-hidden />
          Autonomous daily cycle
        </CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Harvest + deep sweep, once a day, even with the tab closed — the server runs the full
          intelligence cycle on its own schedule.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {inFlight ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" aria-hidden />
                  A cycle is running right now
                </span>
              ) : sweepHold ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" aria-hidden />
                  Previous sweep still in flight
                </span>
              ) : daily ? (
                "Daily mode armed"
              ) : (
                "Off — manual only"
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {inFlight
                ? "Harvesting elite repos and sweeping — events stream into the live feed"
                : sweepHold
                  ? "The last cycle's deep sweep is finishing — a new cycle would duplicate it"
                  : daily
                    ? next
                      ? `Next: ${formatDistanceToNow(next, { addSuffix: true })} · ${format(next, "HH:mm")}`
                      : "Next cycle: at the scheduler's next tick"
                    : "The hunter only moves when you drive it"}
            </p>
          </div>
          <Switch
            checked={daily}
            disabled={!mounted || busy}
            onCheckedChange={(checked) => modeM.mutate(checked ? "daily" : "off")}
            aria-label="Autonomous daily cycle"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {last ? `Last cycle: ${formatDistanceToNow(last, { addSuffix: true })}` : "No cycle has run yet"}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => triggerM.mutate()}
            disabled={!mounted || triggerM.isPending || blocked}
            title={
              blocked
                ? "The current cycle / sweep is still executing — it finishes on its own"
                : "Fire the harvest + deep sweep cycle now, regardless of the schedule"
            }
          >
            {triggerM.isPending || blocked ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            {inFlight ? "Cycle in flight" : sweepHold ? "Sweep finishing" : "Run the cycle now"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
