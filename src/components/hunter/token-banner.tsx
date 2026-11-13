"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KeyRound,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
  PencilLine,
  Trash2,
  ClipboardPaste,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHunterStore } from "@/lib/hunter-store";
import { apiFetch, SERVER_TOKEN } from "@/lib/api-client";
import { useHydrated } from "@/hooks/use-hydrated";
import type { RateInfo } from "@/lib/hunter-types";

/**
 * A prominent token-paste card at the top of the page.
 * Without a token — opens automatically with the field focused: paste → Enter → done.
 * With a valid token — collapses into a thin green bar with a live quota.
 */
interface ServerTokenInfo {
  exists: boolean;
  masked: string | null;
  updatedAt: string | null;
}

export function TokenBanner() {
  const token = useHunterStore((s) => s.token);
  const setToken = useHunterStore((s) => s.setToken);
  const queryClient = useQueryClient();
  const mounted = useHydrated();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasToken = mounted && !!token;
  const open = !mounted || !hasToken || editing;

  // Adopt a server-stored token: a fresh browser session doesn't lose the token — the server holds it
  const { data: serverInfo } = useQuery({
    queryKey: ["server-token"],
    queryFn: () => apiFetch<ServerTokenInfo>("/api/settings/token", ""),
    enabled: mounted && !hasToken,
    staleTime: 30_000,
    retry: 1,
  });
  useEffect(() => {
    if (serverInfo?.exists) {
      setToken(SERVER_TOKEN);
    }
  }, [serverInfo?.exists, setToken]);

  // Shown: masked from the latest local save, or from the server (adoption)
  const shownMasked = masked ?? (serverInfo?.exists ? serverInfo.masked : null);

  const {
    data,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["rate", token],
    queryFn: () => apiFetch<RateInfo>("/api/rate-limit", token),
    enabled: mounted && hasToken,
    staleTime: 60_000,
    retry: 1,
  });

  // Auto-focus on every open — paste immediately without touching the mouse
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 80);
      return () => clearTimeout(t);
    }
  }, [open]);

  const save = async () => {
    const t = draft.trim();
    if (!t) return;
    // The real save happens on the server; the client switches to the sentinel only — the raw PAT
    // never enters state and is never stored in localStorage (previously: setToken(t) kept the raw
    // token in the browser forever).
    try {
      const res = await fetch("/api/settings/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const info = (await res.json().catch(() => null)) as ServerTokenInfo | null;
      if (info?.exists && info.masked) {
        setMasked(info.masked);
        setToken(SERVER_TOKEN);
        setEditing(false);
        setDraft("");
        setSaveError(null);
      } else {
        setSaveError("Saving to the server failed — try again");
      }
    } catch {
      setSaveError("Saving to the server failed — try again");
    }
  };

  const remove = async () => {
    setToken("");
    setMasked(null);
    try {
      const res = await fetch("/api/settings/token", { method: "DELETE" });
      // Round 9 — check res.ok BEFORE invalidating: on a failed DELETE (network/500)
      // the invalidated server-token query refetched, found exists=true, and the
      // adoption effect immediately re-adopted the token the user just removed —
      // the banner flipped back to "active" with no error shown (the catch swallowed
      // the real cause). Now: a failed delete surfaces the failure and does NOT
      // re-adopt; only a successful delete refreshes the caches.
      if (!res.ok) {
        let msg = `The server returned ${res.status} — the token was not removed`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // keep default
        }
        setSaveError(msg);
        // restore local state to the truth: the token is still on the server
        if (serverInfo?.exists) {
          setToken(SERVER_TOKEN);
          setMasked(serverInfo.masked ?? null);
        }
        return;
      }
    } catch {
      // network-level failure — same honesty: no re-adoption race, error surfaced
      setSaveError("Removing the token failed (network) — it is still saved on the server");
      if (serverInfo?.exists) {
        setToken(SERVER_TOKEN);
        setMasked(serverInfo.masked ?? null);
      }
      return;
    } finally {
      // Reset the cache so the removed token isn't re-adopted from cache
      queryClient.invalidateQueries({ queryKey: ["server-token"] });
      queryClient.invalidateQueries({ queryKey: ["rate"] });
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setDraft(text.trim());
        inputRef.current?.focus();
      }
    } catch {
      inputRef.current?.focus();
    }
  };

  // ---------- open state: paste field ----------
  if (open) {
    return (
      <section
        aria-label="Paste GitHub token"
        className="relative mb-6 overflow-hidden rounded-xl border-2 border-orange-400/70 bg-gradient-to-l from-orange-50 via-amber-50/60 to-background p-4 shadow-md sm:p-5 dark:border-orange-500/50 dark:from-orange-950/30 dark:via-amber-950/10 dark:to-background"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3 sm:w-64 sm:shrink-0">
            <div className="flex h-11 w-11 animate-pulse items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-md">
              <KeyRound className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-bold leading-tight sm:text-base">
                Paste your GitHub token here
              </p>
              <p className="text-xs text-muted-foreground">
                Free · 5,000 requests/hour · Unlocks code search
              </p>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Input
                ref={inputRef}
                type="password"
                inputMode="text"
                autoComplete="off"
                placeholder="Paste here: github_pat_... or ghp_..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                dir="ltr"
                className="h-11 border-orange-300 bg-white/90 pr-4 font-mono text-sm shadow-inner focus-visible:ring-orange-400 dark:bg-background/80 dark:border-orange-700"
                aria-label="GitHub token paste field"
              />
            </div>
            <Button
              onClick={pasteFromClipboard}
              variant="outline"
              size="lg"
              className="h-11 shrink-0 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-100 hover:text-orange-800 dark:border-orange-700 dark:text-orange-300 dark:hover:bg-orange-950/50"
              title="Paste from clipboard"
            >
              <ClipboardPaste className="h-4 w-4" />
              <span className="hidden sm:inline">Paste</span>
            </Button>
            <Button
              onClick={save}
              disabled={!draft.trim()}
              size="lg"
              className="h-11 shrink-0 gap-1.5 bg-gradient-to-l from-orange-600 to-amber-600 text-white shadow-md hover:from-orange-700 hover:to-amber-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              Save & check
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <a
            href="https://github.com/settings/tokens?type=beta"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-orange-600 hover:underline dark:text-orange-400"
          >
            No token? Create one on GitHub (30 seconds, no special permissions) <ExternalLink className="h-3 w-3" />
          </a>
          <span>The token is stored only on the local server (not in the browser) and is sent only to the GitHub API.</span>
          {saveError && (
            <span role="alert" className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
              <XCircle className="h-3.5 w-3.5" /> {saveError}
            </span>
          )}
          {hasToken && (
            <button
              onClick={() => {
                setEditing(false);
                setDraft("");
                setSaveError(null);
              }}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <XCircle className="h-3.5 w-3.5" /> Cancel editing
            </button>
          )}
        </div>
      </section>
    );
  }

  // ---------- collapsed state: thin status bar ----------
  const core = data?.core;
  // A real token = a 5,000 quota. Guest = 60. If the quota is at guest level — the token isn't really working.
  const tokenLevelQuota = (core?.limit ?? 0) >= 1000;
  // data?.error is dead here — apiFetch throws on error bodies; the value never arrives as data
  const ok = !error && !!data && tokenLevelQuota;
  const search = data?.search;

  return (
    <div
      role="status"
      className={`mb-6 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-sm ${
        isFetching
          ? "border-muted bg-muted/30 text-muted-foreground"
          : ok
            ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
            : "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
      }`}
    >
      <span className="flex items-center gap-2">
        {isFetching ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        ) : (
          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
        )}
        {isFetching ? (
          "Checking token against GitHub…"
        ) : ok ? (
          <>
            <b>GitHub token active</b>
            {shownMasked && (
              <span dir="ltr" className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                {shownMasked}
              </span>
            )}
            {core && (
              <span dir="ltr" className="font-mono text-xs">
                core {core.remaining}/{core.limit}
                {search ? ` · search ${search.remaining}/${search.limit}` : ""}
              </span>
            )}
          </>
        ) : (
          <>
            <b>GitHub didn't recognize the token</b>
            <span className="text-xs">
              {data?.error ?? error?.message ?? "Guest quota (60/hour) — the saved token isn't working; paste a valid token"}
            </span>
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => {
            setEditing(true);
            setDraft("");
          }}
        >
          <PencilLine className="h-3.5 w-3.5" /> Change token
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-red-600 hover:bg-red-100 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
          onClick={remove}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </span>
    </div>
  );
}
