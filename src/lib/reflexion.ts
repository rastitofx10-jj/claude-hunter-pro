// ============================================================
// Reflexion Engine — the system using itself to get seriously better.
//
// The architectural gap this closes: Claude Hunter mines elite repos,
// gates them, evolves queries, distills field reports… but ALL of that
// intelligence is pointed OUTWARD. Nothing ever analyzed the hunter's
// OWN performance. The telemetry was generated (query yields, gate
// rejections, mission outcomes, sweep stats, library growth) and then
// never read by anyone.
//
// This module is the missing inward loop:
//
//   DB telemetry (real, measured facts only)
//     → LLM analysis with MANDATORY evidence citations
//     → truth gates (a finding without verifiable evidence is rejected
//       and reported — no hallucinations can enter the record)
//     → validated findings are BORN as self-DNA into the library
//     → validated queries enter the live hunt pool, where adaptive
//       learning measures them in the field — sterile queries are
//       evicted automatically (natural selection, not vibes)
//
// Honesty contract:
//   * Every number below comes from a live DB read. If the DB is empty,
//     the run says so and stops — an empty system has nothing to reflect on.
//   * Every finding must cite evidence that appears VERBATIM in the
//     telemetry digest handed to the model. Failing findings are listed
//     in rejectedFindings — the user sees exactly what the AI tried to
//     invent and why it was refused.
//   * The engine never rewrites code or thresholds. It may only propose
//     search queries — the one mutation that is cheap, measurable and
//     fully reversible by the selection pressure already in place.
// ============================================================

import { db } from "./db";
import { llmJson } from "./llm";
import { safeJsonParse } from "./ai-json";
import { loadYieldStats, normalizeQueryKey } from "./adaptive-learning";
import { FRONTIER_CODE_POOL, FRONTIER_REPO_POOL, FRONTIER_MODEL_POOL } from "./frontier-queries";
import { emitDnaBorn, emitReflexion } from "./event-bus";

// ---------- settings keys ----------

/** Setting key holding the accepted reflexion query pool (JSON array of {q, why, bornAt}) */
export const REFLEXION_POOL_KEY = "reflexionPool";
/** Setting key holding the reflexion run history (JSON array, newest last, capped) */
export const REFLEXION_HISTORY_KEY = "reflexionHistory";

const POOL_MAX = 8;
const HISTORY_MAX = 10;
const QUERIES_PER_RUN_MAX = 3;
const FINDINGS_PER_RUN_MAX = 6;

/** A query is auto-evicted from the pool after this many measured runs below
 *  the yield floor — sterile proposals die in the field, exactly like the
 *  adaptive-learning demotion, but with a final verdict. */
const STERILE_RUNS = 3;
const STERILE_YIELD_FLOOR = 0.34;

// ---------- telemetry ----------

export interface ReflexionTelemetry {
  collectedAt: string;
  library: { total: number; byKind: Record<string, number>; topSources: { repo: string; genes: number }[]; bornLast7d: number; bornLast24h: number };
  yieldStats: { tracked: number; top: { q: string; runs: number; genes: number; weight: number }[]; sterile: { q: string; runs: number; genes: number }[] };
  missions: {
    total: number;
    byStatus: Record<string, number>;
    lessonsTotal: number;
    /** Round 15: legacy fiction-purges split from current-era performance. */
    currentEraNote: string;
    currentEra: { active: number; byStatus: Record<string, number> };
  };
  hunts: { total: number; avgDnaGrowth: number | null; lastError: string | null };
  sweeps: { total: number; byStatus: Record<string, number> };
  watchlist: number;
  reflexionPool: { q: string; why: string; bornAt: string }[];
}

/** The digest string handed to the LLM — the ONLY text evidence may cite. */
function telemetryDigest(t: ReflexionTelemetry): string {
  return JSON.stringify(t, null, 1);
}

/** Collect the hunter's own measured state. Every field is a live DB read. */
export async function gatherReflexionTelemetry(): Promise<ReflexionTelemetry> {
  const since7d = new Date(Date.now() - 7 * 86400000);
  const since24h = new Date(Date.now() - 86400000);

  const [
    total, kindRows, sourceRows, born7d, born24h,
    missions, missionRows, huntsRaw, sweepsRaw, sweepRows,
    watchlistCount, pool,
  ] = await Promise.all([
    db.dnaArtifact.count(),
    db.dnaArtifact.findMany({ select: { kind: true } }),
    db.dnaArtifact.findMany({ select: { sourceRepo: true } }),
    db.dnaArtifact.count({ where: { createdAt: { gte: since7d } } }),
    db.dnaArtifact.count({ where: { createdAt: { gte: since24h } } }),
    db.mission.count(),
    db.mission.findMany({ select: { status: true } }),
    db.liveHunt.findMany({ orderBy: { createdAt: "desc" }, take: 12, select: { dnaBefore: true, dnaAfter: true, error: true } }),
    db.sweepRun.count(),
    db.sweepRun.findMany({ select: { status: true } }),
    db.savedRepo.count(),
    loadPool(),
  ]);

  // lessons in mission reports — field distillations that actually produced lessons
  const missionsWithReport = await db.mission.findMany({
    where: { report: { not: null } },
    select: { report: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  let lessonsTotal = 0;
  for (const m of missionsWithReport) {
    const r = safeJsonParse<{ lessons?: unknown }>(m.report, {});
    if (Array.isArray(r.lessons)) lessonsTotal += r.lessons.length;
  }

  // yield stats — the measured productivity of every query the arsenal ever ran
  const ys = await loadYieldStats();
  const allYields = Object.entries(ys).map(([q, s]) => ({
    q, runs: s.runs, genes: s.genes, weight: (s.genes + 1) / (s.runs + 2),
  }));
  const top = allYields.sort((a, b) => b.weight - a.weight).slice(0, 8);
  const sterile = allYields.filter((y) => y.runs >= STERILE_RUNS && y.weight < STERILE_YIELD_FLOOR).slice(0, 8);

  const hunts = huntsRaw;
  const growths = hunts.filter((h) => h.dnaAfter > h.dnaBefore).map((h) => h.dnaAfter - h.dnaBefore);
  const avgGrowth = growths.length > 0 ? growths.reduce((a, b) => a + b, 0) / growths.length : null;
  const lastError = hunts.find((h) => h.error)?.error ?? null;

  // Counts computed in JS from findMany rows — deliberately NOT Prisma groupBy:
  // the dev-server runtime rejected the groupBy _count select shape (aggregate
  // syntax drifted across Prisma versions), and the row counts here are tiny
  // (library sources / mission statuses — dozens at most).
  const byKind: Record<string, number> = {};
  for (const r of kindRows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const byStatusM: Record<string, number> = {};
  for (const r of missionRows) byStatusM[r.status] = (byStatusM[r.status] ?? 0) + 1;
  const byStatusS: Record<string, number> = {};
  for (const r of sweepRows) byStatusS[r.status] = (byStatusS[r.status] ?? 0) + 1;
  const sourceCounts = new Map<string, number>();
  for (const r of sourceRows) sourceCounts.set(r.sourceRepo, (sourceCounts.get(r.sourceRepo) ?? 0) + 1);
  const topSources = Array.from(sourceCounts.entries())
    .map(([repo, genes]) => ({ repo, genes }))
    .sort((a, b) => b.genes - a.genes)
    .slice(0, 10);

  return {
    collectedAt: new Date().toISOString(),
    library: {
      total,
      byKind,
      topSources,
      bornLast7d: born7d,
      bornLast24h: born24h,
    },
    yieldStats: { tracked: allYields.length, top, sterile },
    missions: {
      total: missions,
      byStatus: byStatusM,
      lessonsTotal,
      // Round 15: 'voided' is written ONLY by scripts/truth-migration.ts (a one-time
      // purge of fictional deliverables from the pre-truth era, terminal state).
      // The LLM kept reading those 23 purged rows as a CURRENT failure rate
      // ("62% void rate") and burned reflexion cycles re-flagging a solved problem
      // instead of hunting real ones. The lens is now split explicitly.
      currentEraNote:
        "byStatus.voided counts LEGACY fiction-purged missions (a one-time truth-migration purge, terminal). Current-era performance = currentEra.byStatus only. NEVER report the voided share as a current failure rate or as an active weakness.",
      currentEra: {
        active: missions - (byStatusM.voided ?? 0),
        byStatus: Object.fromEntries(Object.entries(byStatusM).filter(([s]) => s !== "voided")),
      },
    },
    hunts: { total: hunts.length, avgDnaGrowth: avgGrowth === null ? null : Number(avgGrowth.toFixed(1)), lastError },
    sweeps: { total: sweepsRaw, byStatus: byStatusS },
    watchlist: watchlistCount,
    reflexionPool: pool,
  };
}

// ---------- truth gates ----------

/** Whitespace-insensitive, case-insensitive substring containment — the
 *  evidence must be a real quote from the digest (not a paraphrase).
 *  round 12 (LOW-8 truth fix): the check verified only the first 120 chars of
 *  the normalized quote — a genuine 120-char prefix followed by an INVENTED
 *  tail passed the "VERBATIM evidence" gate. The honesty contract (module
 *  header) promises full verbatim quoting; the gate now verifies the ENTIRE
 *  normalized evidence string, matching the promise it enforces. */
function evidenceInDigest(evidence: string, digest: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!evidence || evidence.length < 6) return false;
  return norm(digest).includes(norm(evidence));
}

const QUERY_ALLOWED_RE = /^[\w\s\-\.:,/"'()#>=<@*+]+$/;

/** Quote-insensitive dedup key — GitHub treats `"x"` and `x` as the same
 *  exact-phrase token, so a proposal that differs only by quotation marks is
 *  a puffy duplicate of a known query, not a new coordinate. */
function queryDedupKey(q: string): string {
  return normalizeQueryKey(q).replace(/["']/g, " ").replace(/\s+/g, " ").trim();
}

/** Query candidates must be real GitHub code-searchable strings: sane length,
 *  no injection characters, no duplicates against the static pools or the
 *  already-measured query ledger (quotation-insensitive). */
export function validateQueryCandidate(q: string, known: Set<string>): { ok: boolean; reason?: string } {
  const s = q.trim();
  if (s.length < 8 || s.length > 140) return { ok: false, reason: `length ${s.length} outside 8..140` };
  if (!QUERY_ALLOWED_RE.test(s)) return { ok: false, reason: "contains forbidden characters" };
  if (/[\u0590-\u05FF]/.test(s)) return { ok: false, reason: "non-Latin characters" };
  const key = queryDedupKey(s);
  if (known.has(key) || known.has(normalizeQueryKey(s))) return { ok: false, reason: "duplicate of an existing/known query" };
  if (!/[a-z]/i.test(s)) return { ok: false, reason: "no searchable latin token" };
  return { ok: true };
}

function knownQueryUniverse(pool: { q: string }[]): Set<string> {
  const known = new Set<string>();
  for (const f of [...FRONTIER_CODE_POOL, ...FRONTIER_REPO_POOL, ...FRONTIER_MODEL_POOL]) {
    known.add(queryDedupKey(f.q));
    known.add(normalizeQueryKey(f.q));
  }
  for (const p of pool) {
    known.add(queryDedupKey(p.q));
    known.add(normalizeQueryKey(p.q));
  }
  return known;
}

// ---------- LLM analysis ----------

const REFLEXION_ROLE = `You are the Reflexion Analyst inside Claude Hunter — an intelligence platform that mines Claude/AI capability files (SKILL.md, .claude/commands, agents, MCP configs) from GitHub's elite repos into a DNA library, synthesizes chimeras from them, compiles missions and executes them autonomously.

Your job: analyze the platform's OWN measured telemetry (below) and extract honest, actionable self-improvement. You are NOT analyzing external repos — the subject is the hunter itself.

Hard rules:
1. GROUNDING — every finding MUST quote its evidence VERBATIM from the telemetry JSON (a real number, key or string that literally appears in it). If you cannot quote it, you do not know it — do not invent it. Paraphrases are rejected by the machine gate.
2. NO FICTION — never speculate beyond the numbers. If the library is empty, say the library is empty. Absence of data is itself a finding, not an invitation to imagine.
3. FOCUS — findings about: which query coordinates actually yield genes, which are sterile, library composition gaps (kind imbalances), mission success/failure balance, hunt growth trends, watchlist stagnation.
4. QUERIES — recommend up to 3 NEW GitHub code-search queries that probe coordinates the current arsenal does NOT cover (new capability-file markers, new SDK surfaces, new ecosystem contracts). They must be concrete, syntactically valid GitHub search strings. Do NOT repeat existing queries — the digest lists the known ones.
5. BREVITY — each finding is one title + one evidence quote + one lesson sentence. The lesson must state an OPERATIONAL change (do X more / do Y less / probe Z), not a vague sentiment.

English only.`;

interface LlmFinding { area: string; title: string; evidence: string; lesson: string }
interface LlmQuery { q: string; why: string }
interface LlmReflexion { analysis: string; findings: LlmFinding[]; recommendedQueries: LlmQuery[] }

function parseReflexionOutput(j: Record<string, unknown>): LlmReflexion {
  const findings = (Array.isArray(j.findings) ? j.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      area: typeof f.area === "string" ? f.area.slice(0, 60) : "general",
      title: typeof f.title === "string" ? f.title.slice(0, 140) : "",
      evidence: typeof f.evidence === "string" ? f.evidence.slice(0, 300) : "",
      lesson: typeof f.lesson === "string" ? f.lesson.slice(0, 400) : "",
    }))
    .filter((f) => f.title && f.evidence && f.lesson)
    .slice(0, FINDINGS_PER_RUN_MAX);
  const recommendedQueries = (Array.isArray(j.recommendedQueries) ? j.recommendedQueries : [])
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      q: typeof q.q === "string" ? q.q.trim().slice(0, 140) : "",
      why: typeof q.why === "string" ? q.why.slice(0, 220) : "",
    }))
    .filter((q) => q.q && q.why)
    .slice(0, QUERIES_PER_RUN_MAX);
  return {
    analysis: typeof j.analysis === "string" ? j.analysis.slice(0, 1200) : "",
    findings,
    recommendedQueries,
  };
}

// ---------- pool + history persistence ----------

export interface ReflexionPoolEntry { q: string; why: string; bornAt: string }

async function loadPool(): Promise<ReflexionPoolEntry[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: REFLEXION_POOL_KEY } });
    const parsed = safeJsonParse<ReflexionPoolEntry[]>(row?.value, []);
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.q === "string" && typeof p.why === "string").slice(0, POOL_MAX)
      : [];
  } catch {
    return [];
  }
}

export async function readReflexionPool(): Promise<ReflexionPoolEntry[]> {
  return loadPool();
}

export interface ReflexionRunRecord {
  at: string;
  method: "ai" | "skipped-empty" | "error";
  analysis?: string;
  findingsKept: number;
  findingsRejected: { title: string; reason: string }[];
  queriesAccepted: { q: string; why: string }[];
  queriesRejected: { q: string; reason: string }[];
  dnaBornId: number | null;
  note?: string;
}

async function loadHistory(): Promise<ReflexionRunRecord[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: REFLEXION_HISTORY_KEY } });
    const parsed = safeJsonParse<ReflexionRunRecord[]>(row?.value, []);
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

export async function readReflexionHistory(): Promise<ReflexionRunRecord[]> {
  return loadHistory();
}

async function persistPoolAndHistory(pool: ReflexionPoolEntry[], run: ReflexionRunRecord): Promise<void> {
  // one transaction — the pool and the history must never drift apart
  await db.$transaction([
    db.setting.upsert({
      where: { key: REFLEXION_POOL_KEY },
      update: { value: JSON.stringify(pool) },
      create: { key: REFLEXION_POOL_KEY, value: JSON.stringify(pool) },
    }),
    db.setting.upsert({
      where: { key: REFLEXION_HISTORY_KEY },
      update: { value: JSON.stringify([...historyAppend(await loadHistory(), run)]) },
      create: { key: REFLEXION_HISTORY_KEY, value: JSON.stringify([run]) },
    }),
  ]).catch(async () => {
    // SQLite write-lock retry once with a plain sequential fallback
    await db.setting.upsert({
      where: { key: REFLEXION_POOL_KEY },
      update: { value: JSON.stringify(pool) },
      create: { key: REFLEXION_POOL_KEY, value: JSON.stringify(pool) },
    });
    const hist = await loadHistory();
    await db.setting.upsert({
      where: { key: REFLEXION_HISTORY_KEY },
      update: { value: JSON.stringify(historyAppend(hist, run)) },
      create: { key: REFLEXION_HISTORY_KEY, value: JSON.stringify([run]) },
    });
  });
}

function historyAppend(hist: ReflexionRunRecord[], run: ReflexionRunRecord): ReflexionRunRecord[] {
  const next = [...hist, run];
  return next.slice(-HISTORY_MAX);
}

// ---------- the live pool the harvest draws from ----------

/** Pool entries that are still alive: an entry dies after STERILE_RUNS measured
 *  runs under the yield floor (the field verdict from adaptive-learning).
 *  This is natural selection on the reflexion's own proposals. */
export async function liveReflexionQueries(): Promise<ReflexionPoolEntry[]> {
  const pool = await loadPool();
  if (pool.length === 0) return [];
  const ys = await loadYieldStats();
  const alive = pool.filter((p) => {
    const s = ys[normalizeQueryKey(p.q)];
    if (!s) return true; // never ran yet — deserves its chance in the field
    const weight = (s.genes + 1) / (s.runs + 2);
    return !(s.runs >= STERILE_RUNS && weight < STERILE_YIELD_FLOOR);
  });
  return alive;
}

// ---------- self-DNA birth ----------

/** Minimal YAML scalar escaping — the same law as skill-md.ts applies. */
function yamlScalar(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

async function birthSelfDna(run: ReflexionRunRecord, out: LlmReflexion, kept: LlmFinding[]): Promise<number | null> {
  if (kept.length === 0) return null;
  const ts = run.at.replace(/[:.]/g, "-");
  const name = `self-reflexion-${ts}`;
  const description = `Honest self-analysis of the hunter's own telemetry: ${kept.length} verified findings, ${run.queriesAccepted.length} query mutation(s) accepted.`;
  const lines: string[] = [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    "---",
    "",
    `# Self-Reflexion Lesson — ${run.at}`,
    "",
    out.analysis ? `## Analysis\n\n${out.analysis}\n` : "",
    "## Findings (evidence-verified)",
    "",
  ];
  for (const f of kept) {
    lines.push(`### ${f.area}: ${f.title}`);
    lines.push(`- **Evidence (verbatim from telemetry):** ${f.evidence}`);
    lines.push(`- **Lesson:** ${f.lesson}`);
    lines.push("");
  }
  if (run.queriesAccepted.length > 0) {
    lines.push("## Query Mutations Released Into The Wild");
    lines.push("");
    for (const q of run.queriesAccepted) lines.push(`- \`${q.q}\` — ${q.why}`);
    lines.push("");
    lines.push("These queries entered the harvest pool. Adaptive learning measures them in the field; sterile ones are evicted automatically.");
  }
  if (run.findingsRejected.length > 0) {
    lines.push("## Rejected By The Truth Gate (invention attempts)");
    lines.push("");
    for (const r of run.findingsRejected) lines.push(`- "${r.title}" — ${r.reason}`);
    lines.push("");
  }
  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  const created = await db.dnaArtifact.upsert({
    where: { sourceRepo_path: { sourceRepo: "self-reflexion", path: `reflexion/${ts}/SKILL.md` } },
    update: { description, content, size: content.length },
    create: {
      sourceRepo: "self-reflexion",
      path: `reflexion/${ts}/SKILL.md`,
      kind: "skill",
      name,
      description,
      content,
      size: content.length,
      rawUrl: null,
      license: "self", // born from our own runs — our IP, no distribution limits
    },
  });
  emitDnaBorn({ name, source: "self-reflexion", origin: "field", note: "reflexion lesson — evidence-verified" });
  return created.id;
}

// ---------- the run ----------

export async function runReflexion(): Promise<ReflexionRunRecord> {
  const telemetry = await gatherReflexionTelemetry();
  const run: ReflexionRunRecord = {
    at: new Date().toISOString(),
    method: "ai",
    findingsKept: 0,
    findingsRejected: [],
    queriesAccepted: [],
    queriesRejected: [],
    dnaBornId: null,
  };

  // Honesty rule #1: an empty system has nothing to reflect on — say it, don't improvise.
  if (telemetry.library.total === 0 && telemetry.missions.total === 0 && telemetry.sweeps.total === 0) {
    run.method = "skipped-empty";
    run.note = "The system has no measurable history yet (empty library, no missions, no sweeps) — nothing to reflect on. Run a hunt first.";
    await persistPoolAndHistory(await loadPool(), run);
    return run;
  }

  const digest = telemetryDigest(telemetry);
  const userPrompt = `# TELEMETRY DIGEST (the only source of truth — quote from it verbatim)

${digest}

# TASK

1. Analyze this hunter's own performance honestly (the "analysis" field, 4-8 sentences).
2. Extract findings — each with a VERBATIM evidence quote from the digest above.
3. Recommend up to ${QUERIES_PER_RUN_MAX} new GitHub code-search queries for coordinates the arsenal doesn't cover yet.

Known existing queries you must NOT repeat:
${[...FRONTIER_CODE_POOL, ...FRONTIER_REPO_POOL, ...FRONTIER_MODEL_POOL].map((f) => `- ${f.q}`).join("\n")}
${telemetry.reflexionPool.length > 0 ? `\nReflexion queries already in the live pool:\n${telemetry.reflexionPool.map((p) => `- ${p.q}`).join("\n")}` : ""}

Return exactly this JSON:
{"analysis": "…", "findings": [{"area": "library|yield|missions|hunts|sweeps|watchlist", "title": "…", "evidence": "VERBATIM quote from the digest", "lesson": "operational lesson"}], "recommendedQueries": [{"q": "github code-search string", "why": "…"}]}`;

  const j = await llmJson(REFLEXION_ROLE, userPrompt, {
    tier: "deep",
    effort: "high",
    timeoutMs: 240_000,
    timeoutLabel: "reflexion analysis",
    maxTokens: 12_000,
  });
  const out = parseReflexionOutput(j);
  run.analysis = out.analysis;

  // ---- Gate A: evidence verification ----
  const kept: LlmFinding[] = [];
  for (const f of out.findings) {
    if (evidenceInDigest(f.evidence, digest)) {
      kept.push(f);
    } else {
      run.findingsRejected.push({ title: f.title || "(untitled)", reason: "evidence not found verbatim in the telemetry digest — refused as potential invention" });
    }
  }
  run.findingsKept = kept.length;

  // ---- Gate B: query validation ----
  const pool = await loadPool();
  const known = knownQueryUniverse(pool);
  // a reflexion query that already earned its keep is not a duplicate — it IS in the pool
  for (const entry of pool) {
    known.delete(queryDedupKey(entry.q));
    known.delete(normalizeQueryKey(entry.q));
  }
  for (const rec of out.recommendedQueries) {
    const v = validateQueryCandidate(rec.q, known);
    if (v.ok) {
      run.queriesAccepted.push({ q: rec.q.trim(), why: rec.why });
      pool.push({ q: rec.q.trim(), why: rec.why, bornAt: run.at });
      if (pool.length > POOL_MAX) pool.shift(); // FIFO — oldest proposal leaves first
    } else {
      run.queriesRejected.push({ q: rec.q, reason: v.reason ?? "invalid" });
    }
  }

  // ---- self-DNA birth (only from evidence-verified findings) ----
  try {
    run.dnaBornId = await birthSelfDna(run, out, kept);
  } catch (e) {
    run.note = `DNA birth failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"} — findings preserved in the history record`;
  }

  if (run.findingsKept === 0 && run.queriesAccepted.length === 0) {
    run.note = (run.note ? run.note + "; " : "") + "nothing survived the truth gates this run — see rejectedFindings/rejectedQueries for exactly what and why";
  }

  emitReflexion({
    findingsKept: run.findingsKept,
    findingsRejected: run.findingsRejected.length,
    queriesAccepted: run.queriesAccepted.length,
    dnaBornId: run.dnaBornId,
    note: run.note,
  });

  await persistPoolAndHistory(pool, run);
  return run;
}

/** Fire-and-forget for the scheduler (never blocks the daily cycle) */
export function triggerReflexion(): void {
  void runReflexion().catch((e) => console.error("[reflexion] background run failed:", e));
}
