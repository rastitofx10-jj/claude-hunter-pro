"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { BookmarkX, ExternalLink, Loader2, NotebookPen, Search, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScoreBadge } from "./score-badge";
import { BattleSynthesis } from "./battle-synthesis";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import type { WatchItem } from "@/lib/hunter-types";

export function WatchlistPanel({
  onAnalyze,
}: {
  onAnalyze: (fullName: string) => void;
}) {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiFetch<{ items: WatchItem[] }>("/api/watchlist", token),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/watchlist?id=${id}`, token, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["watchlist"] }),
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });
  const saveNote = useMutation({
    mutationFn: (w: WatchItem) =>
      apiFetch("/api/watchlist", token, {
        method: "POST",
        body: JSON.stringify({
          fullName: w.fullName, owner: w.owner, name: w.name, url: w.url,
          description: w.description, stars: w.stars, score: w.score, models: w.models, notes: noteDraft,
        }),
      }),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onError: (e: Error) => toast({ title: "Saving the note failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading watchlist…
      </div>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
        <BookmarkX className="h-10 w-10 opacity-40" />
        <p className="font-medium">Your watchlist is empty</p>
        <p className="max-w-sm text-sm">
          Search for projects, analyze them, and hit "Save" — that's how you build a source library for learning and inspiration
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 🕸️ AI battle synthesis — cross-repo intelligence */}
      <BattleSynthesis items={items} />

      <div className="grid gap-3 md:grid-cols-2">
      {items.map((w) => (
        <Card key={w.id} className="transition-shadow hover:shadow-md">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <ScoreBadge score={w.score} tier={w.score >= 80 ? "elite" : w.score >= 60 ? "gold" : w.score >= 40 ? "silver" : w.score >= 20 ? "bronze" : "seed"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a href={w.url} target="_blank" rel="noreferrer" dir="ltr" className="truncate font-semibold hover:text-orange-600 hover:underline">
                    {w.fullName}
                  </a>
                  <Badge variant="outline" className="shrink-0 text-[10px]">⭐ {w.stars.toLocaleString()}</Badge>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" dir="auto">{w.description || "No description"}</p>
              </div>
            </div>

            {w.models && (
              <div className="flex flex-wrap gap-1" dir="ltr">
                {w.models.split(",").filter(Boolean).map((m) => (
                  <Badge key={m} variant="secondary" className="font-mono text-[10px]">{m}</Badge>
                ))}
              </div>
            )}

            {editing === w.id ? (
              <div className="space-y-2">
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="What do you want to explore/copy from this project?"
                  className="min-h-20 text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveNote.mutate(w)} disabled={saveNote.isPending} className="gap-1 text-xs">
                    {saveNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <NotebookPen className="h-3.5 w-3.5" />} Save note
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)} className="text-xs">Cancel</Button>
                </div>
              </div>
            ) : (
              w.notes && (
                <p className="rounded-lg bg-muted/50 p-2 text-xs leading-relaxed whitespace-pre-wrap">{w.notes}</p>
              )
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onAnalyze(w.fullName)} className="h-8 gap-1.5 text-xs">
                <Search className="h-3.5 w-3.5" /> Re-analyze
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(w.id);
                  setNoteDraft(w.notes ?? "");
                }}
                className="h-8 gap-1.5 text-xs"
              >
                <NotebookPen className="h-3.5 w-3.5" /> {w.notes ? "Edit note" : "Add note"}
              </Button>
              <Button size="sm" variant="ghost" asChild className="h-8 w-8 p-0">
                <a href={w.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => del.mutate(w.id)}
                disabled={del.isPending}
                className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                aria-label="Remove from watchlist"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      </div>
    </div>
  );
}
