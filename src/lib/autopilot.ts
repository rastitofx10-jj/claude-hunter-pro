// ============================================================
// The autopilot engine — step-by-step execution with incremental saving.
// Why step-by-step instead of one big request? Evidence:
// 1. A full request = up to 4×110 blind seconds; the client/gateway may
//    disconnect — and the output is lost.
// 2. Saving after each step = a browser restart does not kill the run; we
//    continue from the next step.
// 3. The client sees real per-step progress instead of a 3-minute spinner.
// A single source of logic — serves both the step endpoint and the historical
// full run.
// Runs on the server side only.
// ============================================================

import { db } from "@/lib/db";
import { safeJsonParse, isTimeoutError } from "./ai-json";
import { executePhase, extractHandoff, type AutopilotStep, type MissionPhase } from "./mission-compiler";
import { advanceStatus, TERMINAL_STATUSES } from "./mission-status";

export interface AutopilotFailure {
  phaseIndex: number;
  error: string;
  /** A transient failure (timeout/busy queue) — will be retried on the next step call, up to one additional attempt */
  transient?: boolean;
  /** The number of failed attempts for this phase (rewritten on every save — 1 on the first failure) */
  attempts?: number;
}

export interface AutopilotState {
  steps: AutopilotStep[];
  failures: AutopilotFailure[];
}

export interface NextPhaseResult {
  done: boolean; // all phases executed (or failed)
  allDone: boolean; // no phase is still pending
  executed: AutopilotStep | null;
  failure: AutopilotFailure | null;
  stepsDone: number;
  totalPhases: number;
  state: AutopilotState;
}

/** Lenient autopilot-state loading — also supports the historical format (failures as strings).
 * deliverable is guaranteed to be a string — historical rows without a deliverable do not
 * crash the UI (previously: s.deliverable.length crashed on undefined). */
export function parseAutopilotState(raw: string | null): AutopilotState {
  const parsed = safeJsonParse<{ steps?: AutopilotStep[]; failures?: (AutopilotFailure | string)[] }>(raw, {});
  const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
    .filter((s) => s && typeof s.phaseIndex === "number")
    .map((s) => ({
      phaseIndex: s.phaseIndex,
      title: typeof s.title === "string" ? s.title : `Phase ${s.phaseIndex + 1}`,
      deliverable: typeof s.deliverable === "string" ? s.deliverable : "",
      executedAt: typeof s.executedAt === "string" ? s.executedAt : new Date(0).toISOString(),
    }));
  const failures = (Array.isArray(parsed.failures) ? parsed.failures : [])
    .map((f): AutopilotFailure | null => {
      if (typeof f === "string") {
        // Historical format: "Phase 2 (title): message"
        const m = f.match(/Phase (\d+)/);
        return { phaseIndex: m ? Number(m[1]) - 1 : -1, error: f, transient: false, attempts: 2 };
      }
      return f && typeof f.phaseIndex === "number"
        ? {
            phaseIndex: f.phaseIndex,
            error: String(f.error ?? "Error"),
            transient: !!f.transient,
            attempts: typeof f.attempts === "number" ? f.attempts : 2,
          }
        : null;
    })
    .filter((f): f is AutopilotFailure => !!f);
  return { steps, failures };
}

export class AutopilotError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "AutopilotError";
    this.status = status;
  }
}

/**
 * A per-mission in-process lock: two parallel step calls (double-click / two
 * tabs) without it — both read the same state and execute the same phase twice
 * (duplicated LLM work and clobbered state). Now the second one waits and then
 * reads fresh state.
 */
const missionLocks = new Map<number, Promise<unknown>>();

async function withMissionLock<T>(missionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = missionLocks.get(missionId) ?? Promise.resolve();
  const gate = prev.catch(() => undefined).then(fn);
  missionLocks.set(missionId, gate);
  try {
    return await gate;
  } finally {
    if (missionLocks.get(missionId) === gate) missionLocks.delete(missionId);
  }
}

/**
 * Runs the next not-yet-executed phase in the mission + saves the result immediately.
 * Returns what was executed (or which phase failed), and the full state after the phase.
 * Protected by a per-mission lock — parallel calls are serialized.
 */
export function runNextAutopilotPhase(missionId: number): Promise<NextPhaseResult> {
  return withMissionLock(missionId, () => runNextAutopilotPhaseLocked(missionId));
}

async function runNextAutopilotPhaseLocked(missionId: number): Promise<NextPhaseResult> {
  const mission = await db.mission.findUnique({ where: { id: missionId } });
  if (!mission) throw new AutopilotError("Mission not found", 404);
  // round 8: a voided (fiction-purged) mission is TERMINAL — executing phases on it
  // and then distilling a report would resurrect the mission AND birth new DNA from
  // the very fiction the truth migration purged. Closed outright.
  if (TERMINAL_STATUSES.includes(mission.status)) {
    throw new AutopilotError(`Mission is ${mission.status} (fiction-purged) — autopilot is closed for it`, 409);
  }

  const planRaw = safeJsonParse<{ phases?: MissionPhase[] } | null>(mission.plan, null);
  const plan = planRaw ?? {}; // "null" in the DB → null → guard against a crash
  const phases = (Array.isArray(plan.phases) ? plan.phases : []).filter(
    (p) => p && typeof p.title === "string"
  );
  if (phases.length === 0) throw new AutopilotError("The mission has no phases to execute", 400);

  const state = parseAutopilotState(mission.autopilot);
  const executedIdx = new Set(state.steps.map((s) => s.phaseIndex));
  // A permanent failure = a phase that failed non-transiently, or a transient
  // one that has already spent its retry.
  // Previously: a single timeout marked the phase as permanently failed —
  // nextIdx skipped it forever and there was no recovery mechanism; the
  // mission stayed partial forever.
  const failedIdxPermanent = new Set(
    state.failures
      .filter((f) => !f.transient || (f.attempts ?? 2) >= 2)
      .map((f) => f.phaseIndex),
  );
  const nextIdx = phases.findIndex((_, i) => !executedIdx.has(i) && !failedIdxPermanent.has(i));

  if (nextIdx === -1) {
    // Everything executed — make sure the status reflects it (stays in_progress until the field report)
    return {
      done: true,
      allDone: true,
      executed: null,
      failure: null,
      stepsDone: state.steps.length,
      totalPhases: phases.length,
      state,
    };
  }

  // The DNA selected at compile time — full content for execution. The executor
  // only uses the first 6 anyway (executePhase: slice(0,6)) — previously all 8
  // rows were loaded including the full content of two that never reached any
  // prompt (a wasted DB investment).
  const dnaRefs = safeJsonParse<{ id: number }[]>(mission.dnaRefs, []);
  const ids = dnaRefs.map((d) => d.id).filter((n) => Number.isInteger(n)).slice(0, 6);
  const dnaRows = ids.length
    ? await db.dnaArtifact.findMany({
        where: { id: { in: ids } },
        select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true, content: true },
      })
    : [];

  // Chain the handoffs from the already-executed phases — in true phase order
  const priorOutputs = state.steps
    .slice()
    .sort((a, b) => a.phaseIndex - b.phaseIndex)
    .map((s) => ({ title: s.title, handoff: extractHandoff(s.deliverable) }));

  if (mission.status === "compiled") {
    await db.mission.update({ where: { id: missionId }, data: { status: "in_progress" } });
  }

  const phase = phases[nextIdx];
  let executed: AutopilotStep | null = null;
  let failResult: AutopilotFailure | null = null;

  try {
    const deliverable = await executePhase({
      goal: mission.goal,
      phase,
      phaseIndex: nextIdx,
      priorOutputs,
      dna: dnaRows,
    });
    executed = { phaseIndex: nextIdx, title: phase.title, deliverable, executedAt: new Date().toISOString() };
  } catch (e) {
    const transient = isTimeoutError(e);
    const prevAttempts = state.failures.find((f) => f.phaseIndex === nextIdx)?.attempts ?? 0;
    failResult = {
      phaseIndex: nextIdx,
      error: e instanceof Error ? e.message : "Unknown error",
      // transient=true → the next step call will retry the phase (up to
      // attempts=2). Previously: a single timeout killed the phase permanently —
      // the mission got stuck partially with no way to recover.
      transient,
      attempts: prevAttempts + 1,
    };
  }

  // One failure record per phase (the last one wins) — a retry does not accumulate duplicate rows
  const failureMap = new Map(state.failures.map((f) => [f.phaseIndex, f]));
  if (failResult) failureMap.set(failResult.phaseIndex, failResult);
  // round 8: a phase that succeeds on retry kept its STALE failure record — the UI and
  // the full-run route reported the superseded transient failure as if it were final.
  // The phase just executed — its failure history is closed.
  if (executed) failureMap.delete(executed.phaseIndex);
  const newState: AutopilotState = {
    steps: executed ? [...state.steps, executed] : state.steps,
    failures: [...failureMap.values()].sort((a, b) => a.phaseIndex - b.phaseIndex),
  };

  // Are there no more pending phases after this one?
  // round 8: a TRANSIENT failure (timeout, attempts=1) on the LAST pending phase was
  // counted as terminal here — allDone=true stopped the client pump (mission-control
  // breaks on allDone||done), the full-run loop, and live-hunt's stageExecute (which
  // advances the hunt to grow and distills the mission as "partial"), so the retry the
  // transient mechanism promises NEVER fired. Only a PERMANENT failure (non-transient,
  // or transient that spent its retry) may close a phase.
  const nowExecuted = new Set(newState.steps.map((s) => s.phaseIndex));
  const nowFailedPermanent = new Set(
    newState.failures
      .filter((f) => !f.transient || (f.attempts ?? 2) >= 2)
      .map((f) => f.phaseIndex),
  );
  const allDone = phases.every((_, i) => nowExecuted.has(i) || nowFailedPermanent.has(i));

  // Status: all failures = failed; otherwise it stays in_progress until the
  // field report. One-way transition rule: partial/done are never demoted back
  // to in_progress (previously: re-running autopilot on a partial/finished
  // mission demoted it backward)
  const computed =
    allDone && newState.steps.length === 0 && newState.failures.length > 0 ? "failed" : "in_progress";
  // The race-condition key: mission.status is read at the top of the function —
  // before up to 220 seconds of executePhase. A field report finishing in
  // parallel (status → done) was trampled to in_progress by this write.
  // Now: a fresh read inside the lock, right before the write.
  const fresh = await db.mission.findUnique({ where: { id: missionId }, select: { status: true } });
  const currentStatus = fresh?.status ?? mission.status;
  const status = advanceStatus(currentStatus, computed);

  await db.mission.update({
    where: { id: missionId },
    data: { autopilot: JSON.stringify(newState), autopilotAt: new Date(), status },
  });

  return {
    done: false,
    allDone,
    executed,
    failure: failResult,
    stepsDone: newState.steps.length,
    totalPhases: phases.length,
    state: newState,
  };
}
