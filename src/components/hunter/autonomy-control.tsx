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
      toast.success(d.note ?? "The autonomous cycle is starting");
      void qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
    onError: (e: Error) => toast.error("Could not trigger the cycle", { description: e.message }),
  });

  const daily = data?.mode === "daily";
  const last = parseable(data?.lastCycleAt);
  const next = parseable(data?.nextCycleAt);
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
            <p className="text-sm font-semibold">{daily ? "Daily mode armed" : "Off — manual only"}</p>
            <p className="text-[11px] text-muted-foreground">
              {daily
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
            disabled={!mounted || triggerM.isPending}
            title="Fire the harvest + deep sweep cycle now, regardless of the schedule"
          >
            {triggerM.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            Run the cycle now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
