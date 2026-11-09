// ============================================================
// Sweep operation runner — connects all the stages with live progress in the DB:
// queries (40%) ← enrichment (52%) ← mining (70%) ← prompt swarm (98%) ← done
// One active run at any moment. An operational failure doesn't take down the whole sweep.
// Server-side only.
// ============================================================

import { db } from "./db";
import { safeJsonParse } from "./ai-json";
import {
  buildQueryArsenal,
  runQueryArsenal,
  consolidateCandidates,
  enrichCandidates,
  mineTopCandidates,
  flattenForSwarm,
  type Candidate,
  type QueryReport,
} from "./deep-sweep";
import { runSwarm, SWARM_TRIAGE_COVERAGE, type SwarmResult } from "./intel-swarm";
import { resolveToken } from "./server-token";
import { parseAudit } from "./auditor";
import { writeDnaSnapshot } from "./dna-snapshot";
import type { NextRequest } from "next/server";

const activeRuns = new Set<number>();
let startingSweep = false; // start lock: closes the race window between the check and creation (double POST = one sweep)

/** A running row not updated beyond this = finished (crash/restart) — released automatically.
 * Before: a stuck running row blocked new sweeps forever (permanent 409). */
const STALE_RUN_MS = 15 * 60_000; // 15 minutes without a progress update = dead

async function reapStaleRuns(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const dead = await db.sweepRun.updateMany({
      where: { status: "running", updatedAt: { lt: cutoff } },
      data: { status: "failed", error: "The run was interrupted (the server was restarted) — marked automatically" },
    });
    if (dead.count > 0) console.error(`[sweep] reaped ${dead.count} stale running row(s)`);
  } catch (e) {
    console.error("[sweep] stale reaper failed", e);
  }
}

export async function hasActiveRun(): Promise<boolean> {
  await reapStaleRuns();
  const running = await db.sweepRun.findFirst({ where: { status: "running" }, select: { id: true } });
  return running !== null || activeRuns.size > 0;
}

async function updateRun(
  id: number,
  data: { status?: string; phase?: string; progress?: number; queries?: string; stats?: string; findings?: string; briefing?: string; error?: string }
): Promise<void> {
  try {
    await db.sweepRun.update({ where: { id }, data });
  } catch {
    // The run was deleted mid-operation — stop silently
  }
}

/** The run core — not thrown directly to the client; every error is saved on the run row */
async function executeSweep(runId: number, token: string | null): Promise<void> {
  const startedAt = Date.now();
  activeRuns.add(runId);
  try {
    // ---------- Stage A: queries ----------
    const arsenal = buildQueryArsenal();
    const reports: QueryReport[] = [];
    await updateRun(runId, { phase: "queries", progress: 1 });

    const { codeHits, repoHits } = await runQueryArsenal(token, arsenal, async (report, done, total) => {
      reports.push(report);
      const progress = Math.round((done / total) * 40);
      await updateRun(runId, {
        progress: Math.max(1, progress),
        queries: JSON.stringify(reports),
      });
    });

    // ---------- Stage B: consolidation + enrichment ----------
    await updateRun(runId, { phase: "enrich", progress: 41 });
    let candidates: Candidate[] = consolidateCandidates(codeHits, repoHits);
    const enriched = await enrichCandidates(candidates, token, 30);
    await updateRun(runId, { phase: "mine", progress: 52 });

    // ---------- Stage C: DNA mining ----------
    const dnaAddedTotal = { n: 0 };
    let reposMined = 0; // per the report's definition: repos swept without error
    let reposWithFindings = 0;
    let mineErrors = 0;
    const minedReports = await mineTopCandidates(candidates, token, 8, async (done, total, rep) => {
      if (!rep.error) {
        reposMined++;
        dnaAddedTotal.n += rep.newCount;
        if (rep.artifacts > 0) reposWithFindings++;
      } else {
        mineErrors++;
      }
      const progress = 52 + Math.round((done / Math.max(1, total)) * 18);
      await updateRun(runId, { progress });
    });
    // Mining failures are no longer thrown — before, "3 repos mined" hid 5 failures
    // and the DB row didn't record them at all (a divergence from the live hunt, which does report them).
    const mineErrorList = minedReports.reports
      .filter((r) => r.error)
      .slice(0, 6)
      .map((r) => `${r.repo}: ${r.error}`);

    const [totalLibrary, fieldDna] = await Promise.all([
      db.dnaArtifact.count(),
      db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
    ]);

    // ---------- Stage D: prompt swarm ----------
    await updateRun(runId, { phase: "swarm", progress: 71 });
    // The mine phase just completed and the library may have grown — snapshot it automatically
    // in the background (the manual script required a human to remember). Fire-and-forget:
    // the sweep's own flow never waits on (or fails from) snapshot I/O.
    void writeDnaSnapshot().catch((e) => console.error("[dna-snapshot]", e));

    const flat = flattenForSwarm(candidates);
    // Query evolution needs a real {q,count,error} — before, only strings were passed,
    // the prompt received "undefined results", and the dead-query list was always empty.
    const executedQueries = reports.map((r) => ({ q: r.q, count: r.count, error: r.error ?? null }));
    const statsLine = `${arsenal.length} queries · ${codeHits.length} code hits · ${repoHits.length} repos · ${candidates.length} candidates · ${enriched} enriched`;

    let swarm: SwarmResult | null = null;
    try {
      swarm = await runSwarm(flat, executedQueries, dnaAddedTotal.n, statsLine, async (done, total) => {
        const progress = 71 + Math.round((done / Math.max(1, total)) * 27);
        await updateRun(runId, { progress });
      });
    } catch (e) {
      // The whole swarm fell — the sweep is still worthwhile with the raw findings
      await updateRun(runId, {
        briefing: JSON.stringify({
          triage: [],
          profiles: [],
          patterns: { patterns: [], stackConsensus: [], marketShift: "" },
          attack: { topMoves: [], differentiators: [], immediateActions: [] },
          queryEvolution: { nextQueries: [], blindSpots: [], rationale: "" },
          brief: {
            headline: "The swarm failed — raw findings only",
            keyIntel: [],
            decisiveMove: "",
            riskMap: [e instanceof Error ? e.message : "Unknown AI error"],
          },
          llmCalls: 0,
          llmFailures: [e instanceof Error ? e.message : "Unknown AI error"],
        }),
      });
    }

    // ---------- Summary ----------
    const eliteCount = swarm ? swarm.triage.filter((t) => t.verdict === "elite").length : 0;
    const stats = {
      queriesRun: arsenal.length,
      queryErrors: reports.filter((r) => r.error).length,
      codeHits: codeHits.length,
      repoHits: repoHits.length,
      candidatesFound: candidates.length,
      enriched,
      hardEvidence: candidates.filter((c) => c.evidence === "hard").length,
      reposMined,
      reposWithFindings,
      mineErrors,
      mineErrorList,
      dnaAdded: dnaAddedTotal.n,
      totalLibrary,
      fieldDna,
      llmCalls: swarm?.llmCalls ?? 0,
      llmFailures: swarm?.llmFailures.length ?? 0,
      eliteCount,
      elapsedMs: Date.now() - startedAt,
    };

    // Merge the swarm's verdicts into the findings — only up to the actual triage coverage.
    // Before, 60 were saved when only 36 got a verdict — rows 37-60 showed "pending" forever.
    const triageMap = new Map((swarm?.triage ?? []).map((t) => [t.fullName, t]));
    const profMap = new Map((swarm?.profiles ?? []).map((p) => [p.fullName, p]));
    const findings = flat.slice(0, SWARM_TRIAGE_COVERAGE).map((c) => ({
      ...c,
      verdict: triageMap.get(c.fullName)?.verdict ?? null,
      confidence: triageMap.get(c.fullName)?.confidence ?? null,
      triageReason: triageMap.get(c.fullName)?.reason ?? null,
      investment: profMap.get(c.fullName)?.investment ?? null,
      signature: profMap.get(c.fullName)?.signature ?? null,
      stealThis: profMap.get(c.fullName)?.stealThis ?? [],
      blindSpot: profMap.get(c.fullName)?.blindSpot ?? null,
    }));

    await updateRun(runId, {
      status: "done",
      phase: "done",
      progress: 100,
      findings: JSON.stringify(findings),
      ...(swarm ? { briefing: JSON.stringify(swarm) } : {}),
      stats: JSON.stringify(stats),
    });
  } catch (e) {
    await updateRun(runId, {
      status: "failed",
      error: e instanceof Error ? e.message : "Unknown error",
    });
  } finally {
    activeRuns.delete(runId);
  }
}

/** Start a new run in the background — returns the id immediately. Protected against double-POST races */
export async function startSweep(req: NextRequest): Promise<{ id: number }> {
  if (startingSweep || (await hasActiveRun())) {
    const err = new Error("A sweep is already running — wait for it to finish or check the status");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  startingSweep = true;
  try {
    // Re-check after acquiring the lock — two parallel POSTs: only the first passes
    if (await hasActiveRun()) {
      const err = new Error("A sweep is already running — wait for it to finish or check the status");
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const token = await resolveToken(req);
    const run = await db.sweepRun.create({
      data: { status: "running", phase: "queries", progress: 0 },
    });
    activeRuns.add(run.id); // registered before the run — hasActiveRun detects it immediately
    // Background run — intentionally without await
    void executeSweep(run.id, token);
    return { id: run.id };
  } finally {
    startingSweep = false;
  }
}

/** Break down a run row for display */
export function parseSweepRow(row: {
  id: number;
  status: string;
  phase: string;
  progress: number;
  queries: string | null;
  stats: string | null;
  findings: string | null;
  briefing: string | null;
  audit: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    queries: safeJsonParse<QueryReport[]>(row.queries, []),
    stats: safeJsonParse<Record<string, number | string[]>>(row.stats, {}),
    findings: safeJsonParse<unknown[]>(row.findings, []),
    briefing: safeJsonParse<Record<string, unknown> | null>(row.briefing, null),
    audit: parseAudit(row.audit),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
