import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeJsonParse } from "@/lib/ai-json";

// ============================================================
// Intelligence analytics — one read-only route that turns the raw
// operational DB into the numbers the Insights tab renders:
//
//   dnaGrowth     — genes born per day (last 30 days) + running total
//   library        — total / field / mined + kind breakdown
//   topRepos       — the richest DNA sources
//   missions       — status funnel
//   hunts          — verdicts, LLM pressure, elapsed time
//   sweeps         — query/gene/elapsed averages (last 50 parsed)
//   chimeras       — count + latest names
//   llmUsage       — the persistent daily cost ledger (Setting key
//                    "llmUsageDaily" — survives restarts, unlike the
//                    process-memory stats of /api/llm)
//   modelRadar     — the frontier ledger: emerging models, mentions,
//                    vouches, confirmed state
//
// Every section is independently guarded — a corrupted JSON column
// degrades to its default instead of failing the whole route.
// ============================================================

export const dynamic = "force-dynamic";

const LLM_USAGE_KEY = "llmUsageDaily";
const FRONTIER_LEDGER_KEY = "frontierLedger";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const now = Date.now();
  try {
    const [dnaRows, missionRows, huntRows, sweepRows, chimeraCount, llmUsageRow, ledgerRow] =
      await Promise.all([
        db.dnaArtifact.findMany({ select: { sourceRepo: true, kind: true, createdAt: true, name: true } }),
        db.mission.findMany({ select: { status: true, createdAt: true } }),
        db.liveHunt.findMany({ select: { status: true, llmCalls: true, elapsedMs: true, dnaBefore: true, dnaAfter: true, createdAt: true } }),
        db.sweepRun.findMany({ select: { status: true, stats: true, createdAt: true }, orderBy: { id: "desc" }, take: 50 }),
        db.chimera.count(),
        db.setting.findUnique({ where: { key: LLM_USAGE_KEY } }),
        db.setting.findUnique({ where: { key: FRONTIER_LEDGER_KEY } }),
      ]);

    // ---- DNA growth (last 30 days) ----
    const since = now - 30 * 24 * 3600_000;
    const perDay = new Map<string, number>();
    for (const row of dnaRows) {
      const t = row.createdAt.getTime();
      if (t < since) continue;
      const k = dayKey(row.createdAt);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const growthDays: { day: string; born: number; total: number }[] = [];
    let runningTotal = 0;
    for (let i = 29; i >= 0; i--) {
      const d = dayKey(new Date(now - i * 24 * 3600_000));
      const born = perDay.get(d) ?? 0;
      runningTotal += born;
      growthDays.push({ day: d.slice(5), born, total: runningTotal });
    }

    // ---- library composition ----
    const fieldRepos = dnaRows.filter((r) => r.sourceRepo.startsWith("field:"));
    const kinds = new Map<string, number>();
    for (const r of dnaRows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);

    // ---- top sources (non-field, by gene count) ----
    const repoCounts = new Map<string, number>();
    for (const r of dnaRows) {
      if (r.sourceRepo.startsWith("field:")) continue;
      repoCounts.set(r.sourceRepo, (repoCounts.get(r.sourceRepo) ?? 0) + 1);
    }
    const topRepos = [...repoCounts.entries()]
      .map(([repo, genes]) => ({ repo, genes }))
      .sort((a, b) => b.genes - a.genes)
      .slice(0, 10);

    // ---- missions funnel ----
    const missionStatus = new Map<string, number>();
    for (const m of missionRows) missionStatus.set(m.status, (missionStatus.get(m.status) ?? 0) + 1);

    // ---- hunts ----
    const hunts = {
      total: huntRows.length,
      done: huntRows.filter((h) => h.status === "done").length,
      failed: huntRows.filter((h) => h.status === "failed").length,
      running: huntRows.filter((h) => h.status === "running").length,
      llmCalls: huntRows.reduce((s, h) => s + h.llmCalls, 0),
      avgElapsedMs: huntRows.length
        ? Math.round(huntRows.reduce((s, h) => s + h.elapsedMs, 0) / huntRows.length)
        : 0,
      genesBorn: huntRows.reduce((s, h) => s + Math.max(0, h.dnaAfter - h.dnaBefore), 0),
    };

    // ---- sweeps (parse stats JSON of the last 50) ----
    const sweepStats = sweepRows.map((r) => ({
      status: r.status,
      stats: safeJsonParse<Record<string, unknown>>(r.stats, {}),
    }));
    const avg = (field: string): number => {
      const vals = sweepStats
        .map((s) => Number(s.stats[field]))
        .filter((n) => Number.isFinite(n) && n > 0);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    };
    const sweeps = {
      total: sweepStats.length,
      done: sweepStats.filter((s) => s.status === "done").length,
      avgQueries: avg("queriesRun"),
      avgDnaAdded: avg("dnaAdded"),
      avgElapsedMs: avg("elapsedMs"),
      avgLlmCalls: avg("llmCalls"),
    };

    // ---- LLM usage ledger (persistent — created by llm.ts per call) ----
    const usage = safeJsonParse<Record<string, { calls?: number; promptTokens?: number; completionTokens?: number; costUsd?: number }>>(
      llmUsageRow?.value,
      {},
    );
    const llmDays = Object.entries(usage)
      .map(([day, u]) => ({
        day: day.slice(5),
        calls: Number(u.calls ?? 0),
        costUsd: Number(u.costUsd ?? 0),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .slice(-30);
    const llmTotal = Object.values(usage).reduce<{ calls: number; costUsd: number }>(
      (s, u) => ({
        calls: s.calls + Number(u?.calls ?? 0),
        costUsd: s.costUsd + Number(u?.costUsd ?? 0),
      }),
      { calls: 0, costUsd: 0 },
    );

    // ---- model radar (frontier ledger) ----
    const ledger = safeJsonParse<
      { id: string; family: string; version: number; kind: string; mentions: number; repos?: string[]; confirmed?: boolean; firstSeen?: string; lastSeen?: string }[]
    >(ledgerRow?.value, []);
    const modelRadar = ledger
      .filter((e) => e && (e.kind === "emerging" || e.kind === "candidate"))
      .map((e) => ({
        id: e.id,
        family: e.family,
        version: e.version,
        kind: e.kind as "emerging" | "candidate",
        mentions: Number(e.mentions ?? 0),
        vouches: Array.isArray(e.repos) ? e.repos.length : 0,
        confirmed: !!e.confirmed,
        lastSeen: e.lastSeen ?? null,
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 12);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      dna: {
        total: dnaRows.length,
        field: fieldRepos.length,
        mined: dnaRows.length - fieldRepos.length,
        kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })),
        growthDays,
        topRepos,
        latest: dnaRows
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 8)
          .map((r) => ({ name: r.name, repo: r.sourceRepo, kind: r.kind, at: r.createdAt.toISOString() })),
      },
      missions: {
        total: missionRows.length,
        byStatus: [...missionStatus.entries()].map(([status, count]) => ({ status, count })),
      },
      hunts,
      sweeps,
      chimeras: { total: chimeraCount },
      llm: { days: llmDays, total: llmTotal },
      modelRadar,
    });
  } catch (e) {
    console.error("[stats]", e);
    return NextResponse.json({ error: "Failed to compute intelligence statistics" }, { status: 500 });
  }
}
