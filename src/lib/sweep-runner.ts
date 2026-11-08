// ============================================================
// מריץ מבצע הסריקה — מחבר את כל השלבים עם התקדמות חיה ב-DB:
// שאילתות (40%) ← העשרה (52%) ← כרייה (70%) ← להקת פרומפטים (98%) ← הושלם
// ריצה אחת פעילה בכל רגע. כשל מבצעי לא מפיל את הסריקה כולה.
// צד שרת בלבד.
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
import { runSwarm, type SwarmResult } from "./intel-swarm";
import { resolveToken } from "./server-token";
import { parseAudit } from "./auditor";
import type { NextRequest } from "next/server";

const activeRuns = new Set<number>();
let startingSweep = false; // נעילת-תחילה: סוגר את חלון המירוץ בין הבדיקה ליצירה (POST כפול = סריקה אחת)

/** שורת running שלא התעדכנה מעבר לזה = נגמרה (crash/restart) — משחררים אוטומטיק.
 * בעבר: שורת running תקועה חסמה את פתיחת סריקות חדשות לנצח (409 תמידי). */
const STALE_RUN_MS = 15 * 60_000; // 15 דקות בלי עדכון התקדמות = מת

async function reapStaleRuns(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const dead = await db.sweepRun.updateMany({
      where: { status: "running", updatedAt: { lt: cutoff } },
      data: { status: "failed", error: "הריצה נקטעה (השרת אותחל) — סימון אוטומטי" },
    });
    if (dead.count > 0) console.error(`[sweep] reaped ${dead.count} stale running row(s)`);
  } catch (e) {
    console.error("[sweep] stale reaper failed", e);
  }
}

export function isRunActive(id: number): boolean {
  return activeRuns.has(id);
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
    // ריצה נמחקה במהלך פעולה — מפסיקים בשקט
  }
}

/** ליבת הריצה — לא נזרקת ישירות ללקוח; כל שגיאה נשמרת בשורת הריצה */
async function executeSweep(runId: number, token: string | null): Promise<void> {
  const startedAt = Date.now();
  activeRuns.add(runId);
  try {
    // ---------- שלב א׳: שאילתות ----------
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

    // ---------- שלב ב׳: איחוד + העשרה ----------
    await updateRun(runId, { phase: "enrich", progress: 41 });
    let candidates: Candidate[] = consolidateCandidates(codeHits, repoHits);
    const enriched = await enrichCandidates(candidates, token, 30);
    await updateRun(runId, { phase: "mine", progress: 52 });

    // ---------- שלב ג׳: כריית DNA ----------
    const dnaAddedTotal = { n: 0 };
    let reposMined = 0;
    const minedReports = await mineTopCandidates(candidates, token, 8, async (done, total, rep) => {
      if (!rep.error) {
        reposMined++;
        dnaAddedTotal.n += rep.newCount;
      }
      const progress = 52 + Math.round((done / Math.max(1, total)) * 18);
      await updateRun(runId, { progress });
    });
    void minedReports;

    const [totalLibrary, fieldDna] = await Promise.all([
      db.dnaArtifact.count(),
      db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
    ]);

    // ---------- שלב ד׳: להקת הפרומפטים ----------
    await updateRun(runId, { phase: "swarm", progress: 71 });

    const flat = flattenForSwarm(candidates);
    // אבולוציית השאילתות זקוקה ל-{q,count,error} אמיתי — בעבר הועברו מחרוזות
    // בלבד, הפרומפט קיבל "undefined תוצאות" ורשימת השאילתות המתות הייתה ריקה תמיד.
    const executedQueries = reports.map((r) => ({ q: r.q, count: r.count, error: r.error ?? null }));
    const statsLine = `${arsenal.length} שאילתות · ${codeHits.length} קודים · ${repoHits.length} מאגרים · ${candidates.length} מועמדים · ${enriched} הועשרו`;

    let swarm: SwarmResult | null = null;
    try {
      swarm = await runSwarm(flat, executedQueries, dnaAddedTotal.n, statsLine, async (done, total) => {
        const progress = 71 + Math.round((done / Math.max(1, total)) * 27);
        await updateRun(runId, { progress });
      });
    } catch (e) {
      // להקה שנפלה כולה — הסריקה עדיין שווה עם הממצאים הגולמיים
      await updateRun(runId, {
        briefing: JSON.stringify({
          triage: [],
          profiles: [],
          patterns: { patterns: [], stackConsensus: [], marketShift: "" },
          attack: { topMoves: [], differentiators: [], immediateActions: [] },
          queryEvolution: { nextQueries: [], blindSpots: [], rationale: "" },
          brief: {
            headline: "הלהקה נכשלה — ממצאים גולמיים בלבד",
            keyIntel: [],
            decisiveMove: "",
            riskMap: [e instanceof Error ? e.message : "שגיאת AI לא ידועה"],
          },
          llmCalls: 0,
          llmFailures: [e instanceof Error ? e.message : "שגיאת AI לא ידועה"],
        }),
      });
    }

    // ---------- סיכום ----------
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
      dnaAdded: dnaAddedTotal.n,
      totalLibrary,
      fieldDna,
      llmCalls: swarm?.llmCalls ?? 0,
      llmFailures: swarm?.llmFailures.length ?? 0,
      eliteCount,
      elapsedMs: Date.now() - startedAt,
    };

    // מיזוג פסקי הדין של הלהקה אל תוך הממצאים
    const triageMap = new Map((swarm?.triage ?? []).map((t) => [t.fullName, t]));
    const profMap = new Map((swarm?.profiles ?? []).map((p) => [p.fullName, p]));
    const findings = flat.slice(0, 60).map((c) => ({
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
      error: e instanceof Error ? e.message : "שגיאה לא ידועה",
    });
  } finally {
    activeRuns.delete(runId);
  }
}

/** פתיחת ריצה חדשה ברקע — מחזיר מיד את המזהה. מוגן מפני תחרות POST כפול */
export async function startSweep(req: NextRequest): Promise<{ id: number }> {
  if (startingSweep || (await hasActiveRun())) {
    const err = new Error("סריקה כבר רצה כרגע — חכה לסיומה או בדוק את המצב");
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  startingSweep = true;
  try {
    // בדיקה חוזרת אחרי תפיסת הנעילה — שני POST מקביליים: רק הראשון עובר
    if (await hasActiveRun()) {
      const err = new Error("סריקה כבר רצה כרגע — חכה לסיומה או בדוק את המצב");
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const token = await resolveToken(req);
    const run = await db.sweepRun.create({
      data: { status: "running", phase: "queries", progress: 0 },
    });
    activeRuns.add(run.id); // נרשם לפני הריצה — hasActiveRun מזהה מיד
    // ריצה ברקע — בכוונה בלי await
    void executeSweep(run.id, token);
    return { id: run.id };
  } finally {
    startingSweep = false;
  }
}

/** פירוק שורת ריצה לתצוגה */
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
    stats: safeJsonParse<Record<string, number>>(row.stats, {}),
    findings: safeJsonParse<unknown[]>(row.findings, []),
    briefing: safeJsonParse<Record<string, unknown> | null>(row.briefing, null),
    audit: parseAudit(row.audit),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
