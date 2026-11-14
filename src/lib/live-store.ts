import { create } from "zustand";

// ============================================================
// The live nervous system's client-side state — a framework-free
// zustand store shared by the SSE hook, the header indicator,
// the overview live strip and (for adaptive polling) the panels.
//
// Kept free of React imports on purpose: non-component code
// (use-hunter-events, refetchInterval closures) can drive it via
// useLiveStore.getState() without a render context.
//
// Shape:
//   connected  — the SSE stream answered "hello" (and no error since)
//   ticker     — the newest event's human text (the header chip shows it)
//   feed       — the last 40 events, newest first (id = monotonic counter)
//   connectionCount — how many successful "hello" handshakes this tab saw
// ============================================================

export const FEED_CAP = 40;

export interface LiveFeedEntry {
  id: number;
  kind: string;
  text: string;
  t: number;
}

/** Minimal structural type of a `hunter` SSE payload (see /api/events). */
export interface HunterEventPayload {
  kind: string;
  t: number;
  [field: string]: unknown;
}

interface LiveState {
  connected: boolean;
  connectionCount: number;
  ticker: { text: string; t: number } | null;
  feed: LiveFeedEntry[];
  setConnected: (connected: boolean) => void;
  pushEvent: (e: HunterEventPayload) => void;
}

// Monotonic feed id — survives StrictMode remounts inside one module instance.
let feedSeq = 0;

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const ORIGIN_LABEL: Record<string, string> = {
  mined: "mined",
  field: "field-born",
  restore: "restored",
};

/** Human one-liner per event kind — the ticker + feed row text. */
export function describeEvent(e: HunterEventPayload): string {
  switch (e.kind) {
    case "sweep": {
      const runId = asNum(e.runId);
      const phase = asStr(e.phase) ?? "update";
      const progress = asNum(e.progress);
      const status = asStr(e.status);
      const note = asStr(e.note);
      let text = `Sweep #${runId ?? "?"} · ${phase}`;
      if (progress != null) text += ` · ${Math.round(progress)}%`;
      if (status && status !== "running") text += ` · ${status}`;
      if (note) text += ` — ${note}`;
      return text;
    }
    case "hunt": {
      const huntId = asNum(e.huntId);
      const stage = asStr(e.stage) ?? "update";
      const status = asStr(e.status);
      const note = asStr(e.note);
      let text = `Hunt #${huntId ?? "?"} · ${stage}`;
      if (status && status !== "running") text += ` · ${status}`;
      if (note) text += ` — ${note}`;
      return text;
    }
    case "mission": {
      const missionId = asNum(e.missionId);
      const phase = asStr(e.phase) ?? asStr(e.status) ?? "update";
      const steps = asNum(e.stepsDone);
      const total = asNum(e.totalPhases);
      const note = asStr(e.note);
      let text = `Mission #${missionId ?? "?"} · ${phase}`;
      if (steps != null && total != null) text += ` · ${steps}/${total}`;
      if (note) text += ` — ${note}`;
      return text;
    }
    case "dna-born": {
      const name = asStr(e.name) ?? "unnamed";
      const source = asStr(e.source);
      const origin = asStr(e.origin);
      let text = `Gene born: ${name} (${ORIGIN_LABEL[origin ?? ""] ?? origin ?? "new"})`;
      if (source) text += ` · from ${source}`;
      return text;
    }
    case "chimera": {
      const name = asStr(e.name) ?? "unnamed";
      const action = asStr(e.action) === "published" ? "published" : "drafted";
      return `Chimera ${action}: ${name}`;
    }
    case "llm": {
      const model = asStr(e.model) ?? "model";
      const cost = asNum(e.costUsd);
      const prompt = asNum(e.promptTokens);
      const completion = asNum(e.completionTokens);
      let text = `LLM · ${model}`;
      if (prompt != null && completion != null) text += ` · ${prompt + completion} tok`;
      if (cost != null) text += ` · $${cost.toFixed(4)}`;
      return text;
    }
    case "rate": {
      const coreR = asNum(e.coreRemaining);
      const coreL = asNum(e.coreLimit);
      const searchR = asNum(e.searchRemaining);
      const searchL = asNum(e.searchLimit);
      const note = asStr(e.note);
      let text = "GitHub quota";
      if (coreR != null || coreL != null) text += ` · core ${coreR ?? "?"}/${coreL ?? "?"}`;
      else if (searchR != null || searchL != null) text += ` · search ${searchR ?? "?"}/${searchL ?? "?"}`;
      if (note) text += ` — ${note}`;
      return text;
    }
    case "autonomy": {
      const note = asStr(e.note) ?? "autonomous cycle update";
      const mode = asStr(e.mode);
      return mode ? `Autonomy (${mode}) — ${note}` : `Autonomy — ${note}`;
    }
    case "snapshot": {
      const written = e.written === true;
      const note = asStr(e.note);
      return `DNA snapshot ${written ? "written" : "skipped"}${note ? ` — ${note}` : ""}`;
    }
    case "reaped": {
      const target = asStr(e.target) ?? "run";
      const id = asNum(e.id);
      return `Reaped ${target} #${id ?? "?"} — stale run closed`;
    }
    default:
      return `Event ${e.kind}`;
  }
}

/** Tiny tone classes for the kind label used by the indicator + overview strip. */
export function kindTone(kind: string): string {
  switch (kind) {
    case "dna-born":
      return "text-emerald-600 dark:text-emerald-400";
    case "chimera":
      return "text-violet-600 dark:text-violet-400";
    case "llm":
      return "text-amber-600 dark:text-amber-400";
    case "hunt":
      return "text-orange-600 dark:text-orange-400";
    case "mission":
      return "text-fuchsia-600 dark:text-fuchsia-400";
    case "sweep":
      return "text-stone-600 dark:text-stone-400";
    case "reaped":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-muted-foreground";
  }
}

export const useLiveStore = create<LiveState>()((set) => ({
  connected: false,
  connectionCount: 0,
  ticker: null,
  feed: [],
  // A "hello" handshake counts once per rising edge — reconnects increment,
  // repeated hellos on the same logical connection do not.
  setConnected: (connected) =>
    set((s) =>
      connected === s.connected
        ? {}
        : connected
          ? { connected: true, connectionCount: s.connectionCount + 1 }
          : { connected: false },
    ),
  pushEvent: (e) => {
    const entry: LiveFeedEntry = {
      id: ++feedSeq,
      kind: e.kind,
      text: describeEvent(e),
      t: typeof e.t === "number" && Number.isFinite(e.t) ? e.t : Date.now(),
    };
    set((s) => ({
      feed: [entry, ...s.feed].slice(0, FEED_CAP),
      ticker: { text: entry.text, t: entry.t },
    }));
  },
}));
