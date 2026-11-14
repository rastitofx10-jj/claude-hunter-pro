"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useLiveStore, type HunterEventPayload } from "@/lib/live-store";

// ============================================================
// The live wire — one EventSource per browser tab to /api/events.
//
// Responsibilities:
// 1. flip the live-store's `connected` flag on hello / onerror
//    (EventSource retries by itself — we never manage reconnects)
// 2. push every `hunter` event into the live-store (ticker + feed)
// 3. smartly invalidate the React Query caches so the panels
//    refresh instantly instead of waiting for their polling
// 4. celebratory toasts for field genes + published chimeras,
//    rate-limited so a mining burst cannot spam the user
//
// Query keys follow the app's EXISTING conventions (they differ from
// the task brief's placeholders — the real keys were read from the
// components): "sweep-list" / "sweep-detail" / "live-hunt-list" /
// "missions" / "dna-library" / "chimeras" / "rate" / "autonomy" / "stats".
// ============================================================

// One stream per browser tab — a module-level owner count guards against
// React StrictMode double-mounting (reactStrictMode is off here, but HMR /
// future-proofing keep the guard).
let activeConnections = 0;

// Toast rate limit: max one celebratory toast per 10s.
let lastToastAt = 0;
// LLM calls are frequent — ["stats"] is invalidated at most once per 30s.
let lastStatsInvalidateAt = 0;
const STATS_INVALIDATE_GAP_MS = 30_000;
const TOAST_GAP_MS = 10_000;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Debounced stats invalidation — an llm event every second must not refetch it. */
function invalidateStats(qc: QueryClient, force = false): void {
  const now = Date.now();
  if (!force && now - lastStatsInvalidateAt < STATS_INVALIDATE_GAP_MS) return;
  lastStatsInvalidateAt = now;
  void qc.invalidateQueries({ queryKey: ["stats"] });
}

function celebrate(e: HunterEventPayload): void {
  const now = Date.now();
  if (now - lastToastAt < TOAST_GAP_MS) return;
  if (e.kind === "dna-born" && e.origin === "field" && isStr(e.name)) {
    lastToastAt = now;
    toast.success("Field gene born", { description: `${e.name} — the library learned from the wild` });
    return;
  }
  if (e.kind === "chimera" && e.action === "published" && isStr(e.name)) {
    lastToastAt = now;
    toast.success("Chimera published", { description: `${e.name} — a synthesized genome went live` });
  }
}

function invalidateForEvent(qc: QueryClient, e: HunterEventPayload): void {
  switch (e.kind) {
    case "sweep":
      void qc.invalidateQueries({ queryKey: ["sweep-list"] });
      // prefix match — refetches whichever sweep detail is on screen
      void qc.invalidateQueries({ queryKey: ["sweep-detail"] });
      return;
    case "hunt":
      void qc.invalidateQueries({ queryKey: ["live-hunt-list"] });
      return;
    case "mission":
      // the mission detail view is component-local state (not query-keyed),
      // so the list is the only cache to refresh here
      void qc.invalidateQueries({ queryKey: ["missions"] });
      return;
    case "dna-born":
      void qc.invalidateQueries({ queryKey: ["dna-library"] });
      // the overview KPI (totalDna/fieldDna) rides on the mission list response
      void qc.invalidateQueries({ queryKey: ["missions"] });
      invalidateStats(qc, true);
      return;
    case "chimera":
      void qc.invalidateQueries({ queryKey: ["chimeras"] });
      invalidateStats(qc, true);
      return;
    case "rate":
      // prefix — covers ["rate", token]
      void qc.invalidateQueries({ queryKey: ["rate"] });
      return;
    case "reaped":
      if (e.target === "sweep") void qc.invalidateQueries({ queryKey: ["sweep-list"] });
      if (e.target === "hunt") void qc.invalidateQueries({ queryKey: ["live-hunt-list"] });
      if (e.target === "mission") void qc.invalidateQueries({ queryKey: ["missions"] });
      return;
    case "autonomy":
      void qc.invalidateQueries({ queryKey: ["autonomy"] });
      return;
    case "llm":
      invalidateStats(qc);
      return;
    case "snapshot":
    default:
      // telemetry only — nothing to refresh
      return;
  }
}

/** Mount the live nervous system. Call exactly once at the page level. */
export function useHunterEvents(): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (activeConnections > 0) {
      // Another mount in this tab already owns the stream — nothing to own,
      // nothing to release (its cleanup closes the shared connection).
      return () => undefined;
    }
    activeConnections++;

    // RELATIVE url only — Caddy proxies /api to the app; an absolute
    // localhost URL would break the moment the sandbox forwards ports.
    const es = new EventSource("/api/events");
    const store = useLiveStore;

    es.addEventListener("hello", () => {
      store.getState().setConnected(true);
    });

    es.addEventListener("hunter", (ev) => {
      let data: HunterEventPayload;
      try {
        data = JSON.parse((ev as MessageEvent<string>).data) as HunterEventPayload;
      } catch {
        return; // malformed payload — telemetry is droppable
      }
      store.getState().pushEvent(data);
      invalidateForEvent(qc, data);
      celebrate(data);
    });

    es.onerror = () => {
      // the browser retries by itself; we only drop the "LIVE" badge
      store.getState().setConnected(false);
    };

    return () => {
      activeConnections--;
      es.close();
      useLiveStore.getState().setConnected(false);
    };
  }, [qc]);
}
