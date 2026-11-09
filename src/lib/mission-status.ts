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
