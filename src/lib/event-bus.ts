// ============================================================
// The Hunter Event Bus — the app's nervous system.
//
// Before v0.4.0 the client could only learn about server-side
// progress by polling DB rows (2.5–4s intervals) and by driving
// long operations with client "step pumps" (POST next → wait → POST
// next). Closing the tab killed an autopilot/hunt mid-run, and the
// UI updates lagged seconds behind reality.
//
// This module is the single process-wide pub/sub hub every engine
// (sweep, live hunt, autopilot, harvest, genesis, LLM layer) emits
// into. The /api/events route subscribes and streams to browsers as
// SSE; the scheduler uses the same bus for its autonomous actions.
//
// Design rules (keep them):
// 1. emit* NEVER throws — an event is telemetry, not control flow.
//    A broken listener must not break the hunt.
// 2. Payloads are small JSON records (no file content, no tokens).
// 3. One wire format: { kind, t, ...payload } — the frontend switch
//    is keyed on `kind`.
// ============================================================

export type HunterEventKind =
  | "sweep" // deep-sweep run: phase/progress transitions
  | "hunt" // live hunt: stage transitions
  | "mission" // mission status / autopilot phase transitions
  | "dna-born" // a DNA artifact entered the library (mined or field)
  | "chimera" // chimera drafted or published
  | "llm" // one LLM call completed (model, tokens, cost)
  | "rate" // GitHub quota observation (core/search windows)
  | "autonomy" // the scheduler's own lifecycle (daily cycle, takeovers)
  | "snapshot" // dna-snapshot write result
  | "reaped"; // a stale run was marked failed by the reaper

export interface HunterEvent {
  kind: HunterEventKind;
  /** epoch ms — filled by emit() */
  t: number;
  [field: string]: unknown;
}

type Listener = (e: HunterEvent) => void;

const listeners = new Set<Listener>();

/** Fan-out to every subscriber. Exception-isolated per listener. */
export function emit(kind: HunterEventKind, payload: Record<string, unknown> = {}): void {
  const e: HunterEvent = { kind, t: Date.now(), ...payload };
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      // a sick listener is dropped silently — telemetry must never crash the engine
    }
  }
}

/** Subscribe; returns an unsubscribe function. */
export function subscribeEvents(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** How many live subscribers (used to cap SSE connections). */
export function eventConnections(): number {
  return listeners.size;
}

// ---------------- typed emitters ----------------
// Small helpers so call-sites stay one-liners and the payload
// contract is enforced by the compiler instead of by memory.

export function emitSweep(p: {
  runId: number;
  phase: string;
  progress: number;
  status?: string;
  note?: string;
}): void {
  emit("sweep", p);
}

export function emitHunt(p: {
  huntId: number;
  stage: string;
  status?: string;
  note?: string;
}): void {
  emit("hunt", p);
}

export function emitMission(p: {
  missionId: number;
  status?: string;
  phase?: string;
  stepsDone?: number;
  totalPhases?: number;
  note?: string;
}): void {
  emit("mission", p);
}

export function emitDnaBorn(p: {
  name: string;
  source: string;
  origin: "mined" | "field" | "restore";
  note?: string;
}): void {
  emit("dna-born", p);
}

export function emitChimera(p: {
  name: string;
  action: "draft" | "published";
  note?: string;
}): void {
  emit("chimera", p);
}

export function emitLlm(p: {
  model: string;
  tier?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  note?: string;
}): void {
  emit("llm", p);
}

export function emitRate(p: {
  coreRemaining?: number;
  coreLimit?: number;
  searchRemaining?: number;
  searchLimit?: number;
  note?: string;
}): void {
  emit("rate", p);
}

export function emitAutonomy(p: {
  note: string;
  mode?: string;
  nextCycleAt?: string;
}): void {
  emit("autonomy", p);
}

export function emitSnapshot(p: { written: boolean; note?: string }): void {
  emit("snapshot", p);
}

export function emitReaped(p: {
  target: "sweep" | "hunt" | "mission";
  id: number;
  note?: string;
}): void {
  emit("reaped", p);
}
