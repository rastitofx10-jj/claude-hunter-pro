// ============================================================
// The law of mission statuses — a single source.
// It used to be redefined in three files (autopilot, report route, live-hunt)
// and one of them had already drifted from the rest — one law, one source.
// Server-side only.
// ============================================================

/** Status ranking: the higher the number, the more advanced. Status transitions are allowed forward only. */
export const STATUS_RANK: Record<string, number> = {
  compiled: 0,
  in_progress: 1,
  partial: 2,
  done: 3,
  failed: 1,
  // round 8: 'voided' (fiction-purged missions, written by scripts/truth-migration.ts
  // as a TERMINAL state) was absent — `?? 0` made advanceStatus("voided","done")
  // return "done", un-voiding 24/30 production missions and letting the report route
  // birth NEW field:mission-<id> DNA from the very fiction the migration purged.
  // Rank 4 = above done: voided is now sticky — nothing outranks it.
  voided: 4,
};

/** Terminal statuses — no field report, no autopilot phase, no status advance past these. */
export const TERMINAL_STATUSES: readonly string[] = ["voided"];

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
