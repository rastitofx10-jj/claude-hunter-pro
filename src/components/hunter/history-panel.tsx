"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { History as HistoryIcon, Loader2, Play, Trash2, Trash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import type { HistoryItem, SearchBody } from "@/lib/hunter-types";

export function HistoryPanel({
  onReRun,
}: {
  onReRun: (body: SearchBody) => void;
}) {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["history"],
    queryFn: () => apiFetch<{ items: HistoryItem[] }>("/api/history", token),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/history?id=${id}`, token, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["history"] }),
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading history…
      </div>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
        <HistoryIcon className="h-10 w-10 opacity-40" />
        <p className="font-medium">No history yet</p>
        <p className="text-sm">Every search you run is saved here automatically — rerun it with one click</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" aria-label="Search history">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          onClick={() => {
            // Confirm before deleting all history (previously: a single click wiped everything without warning)
            if (!window.confirm("Delete the entire search history? This action cannot be undone.")) return;
            del.mutate("all");
          }}
        >
          <Trash className="h-3.5 w-3.5" /> Clear all
        </Button>
      </div>
      {items.map((h) => {
        let body: SearchBody | null = null;
        try {
          if (h.filters) body = JSON.parse(h.filters) as SearchBody;
        } catch {
          body = null;
        }
        return (
          <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-shadow hover:shadow-sm">
            <Badge variant="outline" className="text-[10px]">
              {h.mode === "code" ? "📄 Code" : "🗂️ Repos"}
            </Badge>
            <code dir="ltr" className="max-w-full flex-1 truncate font-mono text-xs">
              {h.query}
            </code>
            <Badge variant="secondary" className="text-[10px]">{h.resultCount} results</Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(h.createdAt).toLocaleString("en-US", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() =>
                  onReRun({
                    ...(body ?? { query: h.query }),
                    mode: h.mode === "code" ? "code" : "repos",
                    page: 1,
                  })
                }
              >
                <Play className="h-3 w-3" /> Rerun
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-red-500"
                aria-label="Delete entry"
                onClick={() => del.mutate(String(h.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
