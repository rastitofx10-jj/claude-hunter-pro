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
 * a query that contributed 3 times with 0 genes ≈ 0.2 (demoted).
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
 * query that surfaced a repo whose mining added genes. Fire-and-forget safe —
 * a persistence failure never takes down the mining stage.
 */
export async function recordQueryYields(attribution: Record<string, number>): Promise<void> {
  const entries = Object.entries(attribution).filter(([, g]) => g > 0);
  if (entries.length === 0) return;
  try {
    const { db } = await import("./db");
    const stats = await loadYieldStats();
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
    await db.setting.upsert({
      where: { key: YIELD_KEY },
      update: { value: JSON.stringify(stats) },
      create: { key: YIELD_KEY, value: JSON.stringify(stats) },
    });
  } catch {
    // Adaptive learning is an optimization — persistence failure is not fatal
  }
}
