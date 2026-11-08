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
 * כרטיס הדבקת טוקן גלוי ובולט בראש העמוד.
 * בלי טוקן — נפתח אוטומטית עם פוקוס בשדה: מדביקים → אנטר → מסיימים.
 * עם טוקן תקין — מתכווץ לפס ירוק דק עם מכסה מחיה.
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

  // אימוץ טוקן שנשמר בשרת: סשן דפדפן חדש לא מאבד את הטוקן — השרת מחזיק אותו
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

  // מוצג: מסוכם מהשמירה המקומית האחרונה, או מהשרת (אימוץ)
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

  // פוקוס אוטומטי בכל פתיחה — מדביקים מיד בלי לגעת בעכבר
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
    // השמירה האמיתית היא בשרת; הלקוח עובר לסנטינל בלבד — PAT גולמי לא נכנס
    // ל-state ולא נשמר ב-localStorage (בעבר: setToken(t) שמר את הטוקן הגולמי בדפדפן לנצח).
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
        setSaveError("השמירה בשרת לא הצליחה — נסה שוב");
      }
    } catch {
      setSaveError("השמירה בשרת לא הצליחה — נסה שוב");
    }
  };

  const remove = async () => {
    setToken("");
    setMasked(null);
    try {
      await fetch("/api/settings/token", { method: "DELETE" });
    } catch {
      // ignore
    } finally {
      // איפוס המטמון כדי שהטוקן שהוסר לא יאומץ מחדש מ-cache
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

  // ---------- מצב פתוח: שדה הדבקה ----------
  if (open) {
    return (
      <section
        aria-label="הדבקת טוקן GitHub"
        className="relative mb-6 overflow-hidden rounded-xl border-2 border-orange-400/70 bg-gradient-to-l from-orange-50 via-amber-50/60 to-background p-4 shadow-md sm:p-5 dark:border-orange-500/50 dark:from-orange-950/30 dark:via-amber-950/10 dark:to-background"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3 sm:w-64 sm:shrink-0">
            <div className="flex h-11 w-11 animate-pulse items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-md">
              <KeyRound className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-bold leading-tight sm:text-base">
                הדביקו כאן טוקן GitHub
              </p>
              <p className="text-xs text-muted-foreground">
                חינם · 5,000 בקשות/שעה · פותח חיפוש קוד
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
                placeholder="הדביקו לכאן: github_pat_... או ghp_..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                dir="ltr"
                className="h-11 border-orange-300 bg-white/90 pr-4 font-mono text-sm shadow-inner focus-visible:ring-orange-400 dark:bg-background/80 dark:border-orange-700"
                aria-label="שדה הדבקת טוקן GitHub"
              />
            </div>
            <Button
              onClick={pasteFromClipboard}
              variant="outline"
              size="lg"
              className="h-11 shrink-0 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-100 hover:text-orange-800 dark:border-orange-700 dark:text-orange-300 dark:hover:bg-orange-950/50"
              title="הדבקה מהלוח"
            >
              <ClipboardPaste className="h-4 w-4" />
              <span className="hidden sm:inline">הדבק</span>
            </Button>
            <Button
              onClick={save}
              disabled={!draft.trim()}
              size="lg"
              className="h-11 shrink-0 gap-1.5 bg-gradient-to-l from-orange-600 to-amber-600 text-white shadow-md hover:from-orange-700 hover:to-amber-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              שמור ובדוק
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
            אין טוקן? יצירה ב-GitHub (30 שניות, בלי הרשאות מיוחדות) <ExternalLink className="h-3 w-3" />
          </a>
          <span>הטוקן נשמר בשרת המקומי בלבד (לא בדפדפן), ומועבר רק ל-GitHub API.</span>
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
              <XCircle className="h-3.5 w-3.5" /> ביטול עריכה
            </button>
          )}
        </div>
      </section>
    );
  }

  // ---------- מצב מכווץ: פס סטטוס דק ----------
  const core = data?.core;
  // טוקן אמיתי = מכסה 5,000. אורח = 60. אם המכסה ברמת אורח — הטוקן לא באמת עובד.
  const tokenLevelQuota = (core?.limit ?? 0) >= 1000;
  // data?.error מת לכאן — apiFetch זורק חריגה על גוף שגיאה; הערך לעולם לא מגיע כ-data
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
          "בודק טוקן מול GitHub…"
        ) : ok ? (
          <>
            <b>טוקן GitHub פעיל</b>
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
            <b>הטוקן לא זוהה על ידי GitHub</b>
            <span className="text-xs">
              {data?.error ?? error?.message ?? "מכסת אורח (60/שעה) — הטוקן השמור לא עובד, הדביקו טוקן תקין"}
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
          <PencilLine className="h-3.5 w-3.5" /> החלף טוקן
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-red-600 hover:bg-red-100 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
          onClick={remove}
        >
          <Trash2 className="h-3.5 w-3.5" /> הסר
        </Button>
      </span>
    </div>
  );
}
