"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHunterStore } from "@/lib/hunter-store";
import { apiFetch } from "@/lib/api-client";
import { TokenDialog } from "./token-dialog";
import { useHydrated } from "@/hooks/use-hydrated";
import type { RateInfo } from "@/lib/hunter-types";

export function RateChip() {
  const token = useHunterStore((s) => s.token);
  const mounted = useHydrated();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["rate", token],
    queryFn: () => apiFetch<RateInfo>("/api/rate-limit", token),
    enabled: mounted,
    staleTime: 60_000,
  });

  const remaining = data?.core?.remaining;
  const limit = data?.core?.limit;
  const low = remaining != null && limit != null && remaining / limit < 0.15;
  const hasToken = mounted && !!token;

  return (
    <div className="flex items-center gap-2">
      <TokenDialog
        trigger={
          <Button variant="outline" size="sm" className="gap-1.5 font-mono" title="GitHub API quota — click for token settings">
            <Gauge className={`h-4 w-4 ${low ? "text-red-500" : "text-emerald-600"}`} />
            {isLoading || !mounted
              ? "…"
              : isError
                ? "Token error"
                : hasToken
                  ? `${remaining ?? "?"}/${limit ?? "?"}`
                  : "Guest"}
          </Button>
        }
      />
      {!mounted ? null : hasToken ? null : (
        <span className="hidden text-xs text-muted-foreground sm:inline">No token — very limited</span>
      )}
    </div>
  );
}
