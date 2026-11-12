"use client";

import { useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { useHydrated } from "@/hooks/use-hydrated";

/** The frontier radar chip — appears ONLY when the ledger holds an emerging
 *  frontier version above the registry. A confirmed wave (≥2 repos) pulses;
 *  an unconfirmed single-repo signal stays muted. Clicking it opens the sweep
 *  tab, where the next run hunts the wave automatically. */
export function FrontierChip({ onOpenSweep }: { onOpenSweep?: () => void }) {
  const token = useHunterStore((s) => s.token);
  const mounted = useHydrated();

  const { data } = useQuery({
    queryKey: ["frontier", token],
    queryFn: () =>
      apiFetch<{ entries: { id: string; label: string; confirmed: boolean; repos: number; mentions: number }[] }>(
        "/api/frontier",
        token,
      ),
    enabled: mounted,
    staleTime: 120_000,
    refetchInterval: 300_000,
  });

  const entries = data?.entries ?? [];
  if (!mounted || entries.length === 0) return null;
  const confirmed = entries.filter((e) => e.confirmed);
  const label =
    confirmed.length > 0
      ? confirmed.map((e) => e.label).join(" · ")
      : entries[0].label;
  const detail = entries
    .slice(0, 4)
    .map((e) => `${e.label} (${e.id}) — ${e.mentions} mentions · ${e.repos} repo(s)${e.confirmed ? " · LIVE WAVE — the arsenal hunts it" : " · unconfirmed, waiting for a 2nd repo"}`)
    .join("\n");

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenSweep}
            className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors md:inline-flex ${
              confirmed.length > 0
                ? "animate-pulse border-violet-400 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-200"
                : "border-violet-300/60 bg-violet-50/50 text-violet-600/90 hover:bg-violet-100/70 dark:border-violet-800/60 dark:bg-violet-950/30 dark:text-violet-300/90"
            }`}
            title="Frontier radar — versions above the registry, detected in the wild"
          >
            <Radar className="h-3.5 w-3.5" aria-hidden />
            Frontier: {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line font-mono text-[11px]">
          {detail}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
