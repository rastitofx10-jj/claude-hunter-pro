"use client";

import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLiveStore, kindTone } from "@/lib/live-store";

// ============================================================
// The LIVE chip — the app's pulse in the sticky header.
// Matches the frontier/rate chip language: a small rounded-full
// pill, dot + short text, muted tones, emerald when the SSE
// stream is alive, stone when it is down (EventSource retries
// on its own — the chip flips back without a reload).
//
// The ticker (last event text, ~48 chars) shows on sm+ only; on
// a 375px viewport the chip collapses to dot + LIVE. Clicking it
// opens the last 10 feed entries with HH:MM:SS timestamps.
// ============================================================

const TICKER_MAX = 48;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function LiveIndicator() {
  const connected = useLiveStore((s) => s.connected);
  const ticker = useLiveStore((s) => s.ticker);
  const feed = useLiveStore((s) => s.feed);
  const connectionCount = useLiveStore((s) => s.connectionCount);

  const tickerText = ticker ? truncate(ticker.text, TICKER_MAX) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Live event feed — ${connected ? "connected" : "offline"}`}
          title={connected ? "Live event feed — streaming server events" : "Live feed offline — reconnecting"}
          className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            connected
              ? "border-emerald-300/70 bg-emerald-50/60 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
        >
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            {connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-stone-400"}`} />
          </span>
          <span className="shrink-0 tabular-nums">{connected ? "LIVE" : "offline"}</span>
          {connected && tickerText && (
            <span className="hidden min-w-0 items-center gap-1.5 sm:inline-flex">
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide opacity-70">
                {feed[0]?.kind}
              </span>
              <span className="min-w-0 truncate font-medium opacity-80">{tickerText}</span>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" aria-label="Recent live events">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <p className="text-xs font-bold">Live event feed</p>
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
              connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
            }`}
          >
            <span className={`inline-flex h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-stone-400"}`} />
            {connected ? `streaming · ${connectionCount} connect${connectionCount === 1 ? "" : "s"}` : "offline — retrying"}
          </span>
        </div>
        {feed.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {connected ? "No events yet — start a hunt, sweep or mission." : "Reconnecting…"}
          </p>
        ) : (
          <ul className="max-h-72 overflow-y-auto p-2" style={{ scrollbarWidth: "thin" }}>
            {feed.slice(0, 10).map((f) => (
              <li key={f.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground" title={String(f.t)}>
                  {format(new Date(f.t), "HH:mm:ss")}
                </span>
                <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wide ${kindTone(f.kind)}`}>
                  {f.kind}
                </span>
                <span className="min-w-0 flex-1 break-words text-muted-foreground" dir="auto">
                  {f.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
