// ============================================================
// Adaptive Learning — chimera #2 "elite-dna-hunter-orchestrator" injection (WO4:
// Adaptive Learning Framework). "Analyzes extraction performance and
// automatically improves discovery" — made concrete:
//
// Every mining run attributes the genes it actually added to the queries that
// surfaced the mined repos. The per-query yield (genes per contribution) is
// persisted, and future query selection ranks proven queries above
// never-productive ones — so the arsenal learns which corners of GitHub
// actually yield DNA (the anti-saturation rotation keeps exploring; this
// decides who survives a budget squeeze).
//
// Storage: Setting key "queryYieldStats" (same proven pattern as mineAttempts).
// Keys are date-normalized (created:>2026-09-11 → created:>{date}) so a query
// hydrated with today's date still matches yesterday's yield record.
//
// The Prisma db client is imported lazily inside the persisting functions —
// importing this module stays side-effect-free (pure ranking functions are
// unit-testable without a database).
// ============================================================

const YIELD_KEY = "queryYieldStats";
/** Cap the tracked queries — an unbounded map would grow forever in the Setting row */
const MAX_TRACKED = 400;

export interface YieldStat {
  /** How many mining runs this query contributed surfaced repos to */
  runs: number;
  /** Genes that entered the library from repos this query surfaced */
  genes: number;
  lastRun: string;
}
export type YieldStats = Record<string, YieldStat>;

/**
 * Normalize a query for yield tracking: relative dates are replaced with a
 * placeholder so hydrated queries (created:>YYYY-MM-DD) key-match across days.
 */
export function normalizeQueryKey(q: string): string {
  return q.trim().replace(/\d{4}-\d{2}-\d{2}/g, "{date}").toLowerCase();
}

export async function loadYieldStats(): Promise<YieldStats> {
  try {
    const { db } = await import("./db");
    const row = await db.setting.findUnique({ where: { key: YIELD_KEY } });
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as YieldStats)
      : {};
  } catch {
    return {};
  }
}

/**
 * Laplace-smoothed genes-per-contribution. An unseen query starts at 0.5
 * (neutral — the rotation decides, not history); a query that contributed
 * repos yielding 20 genes over 4 runs ≈ (20+1)/(4+2) = 3.5 (proven);
 * a query that executed 3 times with 0 genes ≈ (0+1)/(3+2) = 0.2 (demoted).
 */
export function yieldWeight(q: string, stats: YieldStats): number {
  const s = stats[normalizeQueryKey(q)];
  if (!s) return 0.5;
  return (s.genes + 1) / (s.runs + 2);
}

/**
 * Stable ranking by yield weight — ties keep the caller's original order,
 * so the frontier/registry rotation semantics are preserved exactly;
 * learning only decides BETWEEN differently-proven queries.
 */
export function rankByYield<T extends { q: string }>(queries: T[], stats: YieldStats): T[] {
  return queries
    .map((q, i) => ({ q, i, w: yieldWeight(q.q, stats) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.q);
}

/**
 * Record a run's attribution: `attribution[query] = genesAdded` for every
 * query that surfaced a repo whose mining added genes, PLUS `executedQueries` —
 * every query that ran cleanly this run. A query that executed and yielded 0
 * genes gets `runs++` with no genes, so its Laplace weight decays toward 0:
 * demotion is what makes the ranking honest. (Before: only genes>0 entries were
 * recorded, so a sterile query kept the never-run 0.5 weight forever — the
 * ledger was half-blind and could promote but never demote.)
 * Fire-and-forget safe — a persistence failure never takes down the mining stage.
 * Race-safe: the load-merge-save runs inside a transaction with one retry, so a
 * concurrent recorder (hunt mining + sweep mining in the same cycle) can no
 * longer silently drop the other's update via last-writer-wins.
 */
export async function recordQueryYields(
  attribution: Record<string, number>,
  executedQueries: string[] = []
): Promise<void> {
  // Seed executed-but-unproductive queries with 0 genes — the demotion signal.
  // Errored queries are the caller's responsibility to exclude (a rate-limited
  // good query must not count as an empty run).
  // Both maps merge under NORMALIZED keys from the start: attribution arrives
  // with raw keys (date-hydrated runtime strings) and executedQueries with raw
  // keys too — comparing raw vs normalized would double-count a query present
  // in both (runs +2 per call) and split date-variants into phantom entries.
  const merged: Record<string, number> = {};
  for (const [q, genes] of Object.entries(attribution)) {
    const key = normalizeQueryKey(q);
    merged[key] = (merged[key] ?? 0) + genes;
  }
  for (const q of executedQueries) {
    const key = normalizeQueryKey(q);
    if (!(key in merged)) merged[key] = 0;
  }
  const entries = Object.entries(merged);
  if (entries.length === 0) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { db } = await import("./db");
      await db.$transaction(
        async (tx) => {
          const row = await tx.setting.findUnique({ where: { key: YIELD_KEY } });
          const parsed = row?.value ? JSON.parse(row.value) : {};
          const stats: YieldStats =
            parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          const now = new Date().toISOString();
          for (const [q, genes] of entries) {
            const key = normalizeQueryKey(q);
            const prev = stats[key] ?? { runs: 0, genes: 0, lastRun: now };
            stats[key] = { runs: prev.runs + 1, genes: prev.genes + genes, lastRun: now };
          }
          // Evict the stalest entries beyond the cap (keep the hottest learners)
          const keys = Object.keys(stats);
          if (keys.length > MAX_TRACKED) {
            keys
              .sort((a, b) => new Date(stats[a].lastRun).getTime() - new Date(stats[b].lastRun).getTime())
              .slice(0, keys.length - MAX_TRACKED)
              .forEach((k) => delete stats[k]);
          }
          await tx.setting.upsert({
            where: { key: YIELD_KEY },
            update: { value: JSON.stringify(stats) },
            create: { key: YIELD_KEY, value: JSON.stringify(stats) },
          });
        },
        { timeout: 10_000 }
      );
      return;
    } catch {
      // Adaptive learning is an optimization — persistence failure is not fatal.
      // One retry (the loop) covers a transient SQLite write lock; then give up.
    }
  }
}
