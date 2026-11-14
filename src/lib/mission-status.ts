// ============================================================
// The law of mission statuses — a single source.
// It used to be redefined in three files (autopilot, report route, live-hunt)
// and one of them had already drifted from the rest — one law, one source.
// Server-side only (imported by API routes too).
// ============================================================

/**
 * Status ranking: the higher the number, the more advanced.
 * Transitions through advanceStatus() are allowed forward only.
 *
 * round 11: `failed` used to SHARE rank 1 with `in_progress` — so
 * advanceStatus("failed", "in_progress") returned "in_progress": a mission a
 * field report honestly marked failed got RESURRECTED by the next autopilot
 * pump, and the funnel/status history lied (a failed mission bouncing back,
 * ready to "fail" again forever). The honest ladder now reads:
 *
 *   compiled(0) < in_progress(1) < failed(2) < partial(3) < done(4) < voided(5)
 *
 * - failed → in_progress is BLOCKED for machines (autopilot/report/live-hunt).
 *   A human may still deliberately resume via PATCH (ALLOWED_TRANSITIONS below
 *   is the explicit human-override table) — that's a decision, not an accident.
 * - failed → partial/done stays FORWARD (a later, better field report upgrades
 *   the mission's outcome honestly).
 */
export const STATUS_RANK: Record<string, number> = {
  compiled: 0,
  in_progress: 1,
  failed: 2,
  partial: 3,
  done: 4,
  // round 8: 'voided' (fiction-purged missions, written by scripts/truth-migration.ts
  // as a TERMINAL state) was absent — `?? 0` made advanceStatus("voided","done")
  // return "done", un-voiding 24/30 production missions and letting the report route
  // birth NEW field:mission-<id> DNA from the very fiction the migration purged.
  // Rank 5 = above everything: voided is sticky — nothing outranks it.
  voided: 5,
};

/** Terminal statuses — no field report, no autopilot phase, no status advance past these. */
export const TERMINAL_STATUSES: readonly string[] = ["voided"];

/**
 * The HUMAN override table (PATCH /api/mission/[id]) — rehomed here from the
 * route file (round 11) so there is exactly one status-law source, and the
 * deliberate divergence between the two tables is DOCUMENTED instead of
 * accidental: the machine (advanceStatus) may never resurrect a failed
 * mission; a human explicitly may (resume), because a human decision is not
 * an automated accident. Everything else matches the rank law.
 */
export const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  compiled: new Set(["in_progress", "partial", "done", "failed"]),
  in_progress: new Set(["partial", "done", "failed"]),
  // human-only resume paths (rank law forbids these for machines on purpose):
  partial: new Set(["in_progress", "done", "failed"]),
  failed: new Set(["in_progress", "partial", "done"]),
  done: new Set([]), // final — no going back
  voided: new Set([]), // terminal — fiction-purged, closed forever
};

/** Field-result → mission status mapping */
export const OUTCOME_STATUS: Record<string, string> = {
  success: "done",
  partial: "partial",
  failed: "failed",
};

/**
 * One-way status advancement: returns `next` only if it does not rank backwards from `current`.
 * (Previously: every call site implemented the comparison on its own — and one of them had already drifted)
 */
export function advanceStatus(current: string, next: string): string {
  return (STATUS_RANK[next] ?? 0) >= (STATUS_RANK[current] ?? 0) ? next : current;
}
