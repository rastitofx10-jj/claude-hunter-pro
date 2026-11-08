// ============================================================
// ציד חי — שרשרת הרג אוטונומית מלאה בלחיצה אחת.
// הרעיון: כל המנועים שבנינו פועלים על שרשרת אחת סגורה, עם נתונים חיים:
//
//  hunt    — מטח שאילתות GitHub חי (טוקן השרת) → מועמדים עם סף 5.5+
//  swarm   — טריאז׳ה חכמה + פרופילי השקעה (LLM)
//  attack  — דפוסי שוק + תוכנית תקיפה + אבולוציית שאילתות + תדריך (LLM)
//  mine    — כריית DNA חיה מהמטרות המובילות (GitHub → ספריית DNA)
//  compile — גזירת מטרה אוטומטית מהמודיעין → הידור משימה מהגנים החדשים
//  execute — טייס אוטומטי: שלב אחד לכל קריאה, עד לסיום כל השלבים
//  grow    — זיקוק שדה → לידת DNA חדש בספרייה (field:livehunt-<id>)
//  verdict — מסקנת מערכה: מספרים מלאים, הוכחת צמיחת הספרייה
//
// עיקרון מהטייס האוטומטי: שלב אחד לכל קריאת HTTP. מצב נשמר ב-DB אחרי
// כל שלב — ריסטרט לא מפיל את השרשרת, וניתן לנסות שוב מהשלב הנוכחי.
// צד שרת בלבד.
// ============================================================

import { db } from "@/lib/db";
import { safeJsonParse } from "./ai-json";
import {
  buildQueryArsenal,
  runQueryArsenal,
  consolidateCandidates,
  enrichCandidates,
  mineTopCandidates,
  flattenForSwarm,
  type Candidate,
  type CandidateFlat,
  type QueryReport,
  type MinedRepoReport,
} from "./deep-sweep";
import {
  triageBatch,
  sharpProfiles,
  patternSynthesis,
  attackPlan,
  queryEvolution,
  execBrief,
  type TriageVerdict,
  type SharpProfile,
  type MarketPatterns,
  type AttackPlan,
  type QueryEvolution,
  type ExecBrief,
} from "./intel-swarm";
import {
  rankDnaForGoal,
  compileMission,
  distillFieldReport,
  extractHandoff,
  type DnaRow,
  type MissionPhase,
} from "./mission-compiler";
import { runNextAutopilotPhase, parseAutopilotState, AutopilotError } from "./autopilot";

export const LIVE_HUNT_STAGE_ORDER = [
  "hunt",
  "swarm",
  "attack",
  "mine",
  "compile",
  "execute",
  "grow",
  "verdict",
] as const;

export const LIVE_HUNT_STAGE_TITLES: Record<string, string> = {
  hunt: "איתור חי — מטח שאילתות GitHub",
  swarm: "להקת פרומפטים I — טריאז׳ה ופרופילים",
  attack: "להקת פרומפטים II — דפוסים ותוכנית תקיפה",
  mine: "כריית DNA חיה מהמטרות המובילות",
  compile: "הידור משימה מהמודיעין והגנים",
  execute: "ביצוע אוטונומי — טייס פר-שלב",
  grow: "זיקוק שדה — הספרייה גדלה",
  verdict: "מסקנת מערכה — ראיות מלאות",
};

export interface LiveHuntStageRecord {
  key: string;
  title: string;
  summary: string;
  ms: number;
  evidence: Record<string, unknown>;
}

export class LiveHuntError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "LiveHuntError";
    this.status = status;
  }
}

interface HuntCtx {
  id: number;
  done: LiveHuntStageRecord[];
  evidence: (key: string) => Record<string, unknown> | null;
  /** סך קריאות ה-LLM שנצברו עד כה — למסקנת המערכה (מקור אמת אחד) */
  llmCallsSoFar: number;
  /** דור הציד — דור 2+ זורע את שאילתות האבולוציה של הציד הקודם */
  generation: number;
  /** הציד האב — ממנו נזרעו השאילתות המתפתחות */
  seededFrom: number | null;
}

// ---------- טוקן שרת (DB ← env) ----------

async function getStoredToken(): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: "github_pat" } });
    if (row?.value?.trim()) return row.value.trim();
  } catch {
    // נופל ל-env
  }
  return process.env.GITHUB_TOKEN ?? null;
}

// ---------- מבני עזר ----------

interface SwarmStageState {
  flat: CandidateFlat[];
  elite: CandidateFlat[];
  watch: CandidateFlat[];
  triage: TriageVerdict[];
  profiles: SharpProfile[];
  autoSaved: number;
  autoSavedSkipped: number;
  llmCalls: number;
  llmFailures: string[];
}

interface AttackStageState {
  patterns: MarketPatterns;
  attack: AttackPlan;
  queryEvo: QueryEvolution;
  brief: ExecBrief;
  llmCalls: number;
  llmFailures: string[];
}

function readSwarmState(ctx: HuntCtx): SwarmStageState | null {
  const rec = ctx.evidence("swarm");
  if (!rec) return null;
  return rec as unknown as SwarmStageState;
}

function readAttackState(ctx: HuntCtx): AttackStageState | null {
  const rec = ctx.evidence("attack");
  if (!rec) return null;
  return rec as unknown as AttackStageState;
}

function readHuntEvidence(ctx: HuntCtx): Record<string, unknown> | null {
  return ctx.evidence("hunt");
}

function readMineEvidence(ctx: HuntCtx): Record<string, unknown> | null {
  return ctx.evidence("mine");
}

/** קריאת LLM סלחנית — כשל לא מפיל את השלב, נרשם ב-failures */
async function llmTry<T>(fn: () => Promise<T>, failures: string[], label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${label}: ${e instanceof Error ? e.message : "שגיאה"}`);
    return null;
  }
}

// ---------- שלב 1: hunt ----------

/** סיווג שאילתה מתפתחת לנקודת-קצה הנכונה: מותאמי-repo (stars/fork/topic) נמדדים ב-repo search, השאר קוד */
function evolvedKind(q: string): "code" | "repo" {
  if (/\b(stars|fork|pushed|topic|created|size):/i.test(q)) return "repo";
  return "code";
}

const MAX_HUNT_QUERIES = 24;

/**
 * זריעה גנרציונית: השאילתות שהלהקה הציעה בציד האב מממשות בפועל בציד הבן.
 * (בעבר: queryEvolution נרשם ונזרק — הלמידה לא חזרה לשטח. עכשיו הדור הבא צד איתן.)
 */
async function parentEvolvedQueries(ctx: HuntCtx): Promise<{ queries: SweepQuery[]; blindSpots: string[]; parentId: number | null }> {
  if (!ctx.seededFrom) return { queries: [], blindSpots: [], parentId: null };
  const parent = await db.liveHunt.findUnique({ where: { id: ctx.seededFrom } });
  if (!parent) return { queries: [], blindSpots: [], parentId: null };
  const stages = safeJsonParse<LiveHuntStageRecord[]>(parent.stages ?? "[]", []);
  const attack = stages.find((s) => s.key === "attack")?.evidence as { queryEvo?: { nextQueries?: unknown; blindSpots?: unknown } } | undefined;
  const raw = Array.isArray(attack?.queryEvo?.nextQueries) ? (attack!.queryEvo!.nextQueries as unknown[]) : [];
  const blind = Array.isArray(attack?.queryEvo?.blindSpots) ? (attack!.queryEvo!.blindSpots as unknown[]) : [];
  const queries: SweepQuery[] = raw
    .map((x) => String(x ?? "").trim())
    .filter((q) => q.length >= 8 && q.length <= 240)
    .slice(0, 10)
    .map((q) => ({ q, kind: evolvedKind(q), origin: `evolved:gen${ctx.generation}` }));
  return { queries, blindSpots: blind.map((b) => String(b)).slice(0, 4), parentId: parent.id };
}

/** איחוד כל המאגרים שדורות קודמים כבר ראו — לבדיקת חדשנות של הדור */
async function previousKnownRepos(): Promise<Set<string>> {
  const hunts = await db.liveHunt.findMany({ where: { status: "done" }, orderBy: { id: "desc" }, take: 6 });
  const known = new Set<string>();
  for (const h of hunts) {
    const stages = safeJsonParse<LiveHuntStageRecord[]>(h.stages ?? "[]", []);
    const he = stages.find((s) => s.key === "hunt")?.evidence as { flat?: { fullName?: unknown }[]; topCandidates?: { fullName?: unknown }[] } | undefined;
    for (const f of he?.flat ?? []) if (typeof f?.fullName === "string") known.add(f.fullName);
    for (const t of he?.topCandidates ?? []) if (typeof t?.fullName === "string") known.add(t.fullName);
  }
  return known;
}

async function stageHunt(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const token = await getStoredToken();
  const arsenal = buildQueryArsenal();

  // זריעה גנרציונית — שאילתות האבולוציה של האב נכנסות לשטח באמת
  const seed = await parentEvolvedQueries(ctx);
  const seenQ = new Set(arsenal.map((q) => q.q.toLowerCase()));
  const evolved = seed.queries.filter((q) => !seenQ.has(q.q.toLowerCase()));
  const budget = Math.max(0, MAX_HUNT_QUERIES - evolved.length);
  const staticQ = [...arsenal.filter((q) => q.origin.startsWith("registry")), ...arsenal.filter((q) => !q.origin.startsWith("registry"))].slice(0, budget);
  const queries = [...staticQ, ...evolved];

  const { reports, codeHits, repoHits } = await runQueryArsenal(token, queries, () => {});
  let candidates: Candidate[] = consolidateCandidates(codeHits, repoHits);
  const enriched = await enrichCandidates(candidates, token, 20);
  const flat = flattenForSwarm(candidates);

  // חדשנות — מה הדור הזה מגלה מעבר לכל הידע המצטבר של הדורות הקודמים
  const known = await previousKnownRepos();
  const novelCandidates = candidates.filter((c) => !known.has(c.fullName));

  const hard = candidates.filter((c) => c.evidence === "hard").length;
  const genTag = ctx.generation > 1 ? ` · דור ${ctx.generation} (זריעה מציד #${seed.parentId}: ${evolved.length} שאילתות)` : "";
  const novelTag = known.size > 0 ? ` · ${novelCandidates.length} חדשים מעבר לידע קודם` : "";
  const summary = `${queries.length} שאילתות · ${candidates.length} מועמדים מדורגים · ${hard} עם ראיה קשה · ${repoHits.length} מאגרים${genTag}${novelTag}`;

  return {
    summary,
    evidence: {
      withToken: !!token,
      generation: ctx.generation,
      seededFrom: seed.parentId,
      evolvedQueries: evolved.map((q) => ({ q: q.q, kind: q.kind, origin: q.origin })),
      parentBlindSpots: seed.blindSpots,
      novelCandidates: known.size > 0 ? novelCandidates.length : null,
      novelTop: novelCandidates.slice(0, 10).map((c) => ({
        fullName: c.fullName,
        stars: c.stars,
        score: c.score,
        evidence: c.evidence,
        modelStrings: c.modelStrings.slice(0, 4),
      })),
      knownBefore: known.size,
      queries: reports.map((r: QueryReport) => ({ q: r.q, kind: r.kind, count: r.count, error: r.error ?? null, origin: r.origin })),
      codeHits: codeHits.length,
      repoHits: repoHits.length,
      candidates: candidates.length,
      enriched,
      hardEvidence: hard,
      flat: flat.slice(0, 12),
      topCandidates: candidates.slice(0, 10),
      executedQueries: queries.map((q) => q.q),
      statsLine: `${queries.length} שאילתות · ${codeHits.length} קודים · ${repoHits.length} מאגרים · ${candidates.length} מועמדים · ${enriched} הועשרו`,
      topList: candidates.slice(0, 8).map((c) => ({
        fullName: c.fullName,
        stars: c.stars,
        score: c.score,
        evidence: c.evidence,
        tierLabel: c.tierLabel,
        modelStrings: c.modelStrings.slice(0, 5),
      })),
    },
  };
}

// ---------- שלב 2: swarm (טריאז׳ה + פרופילים) ----------

async function stageSwarm(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const flat = (huntEv?.flat as CandidateFlat[] | undefined) ?? [];
  if (flat.length === 0) {
    return {
      summary: "אין מועמדים מהשלב הקודם — הלהקה מדלגת",
      evidence: { flat: [], triage: [], profiles: [], elite: [], watch: [], llmCalls: 0, llmFailures: [] },
    };
  }

  const failures: string[] = [];
  let calls = 0;

  // טריאז׳ה — אצווה אחת של 12 (גבול זמן HTTP נשמר)
  const batch = flat.slice(0, 12);
  const triage = (await llmTry(() => triageBatch(batch), failures, "טריאז׳ה")) ?? [];
  if (triage.length > 0) calls++;

  const eliteNames = new Set(triage.filter((t) => t.verdict === "elite").map((t) => t.fullName));
  const watchNames = new Set(triage.filter((t) => t.verdict === "watch").map((t) => t.fullName));
  const elite = batch.filter((c) => eliteNames.has(c.fullName)).slice(0, 12);
  const watch = batch.filter((c) => watchNames.has(c.fullName)).slice(0, 12);

  // פרופילים לאליטה בלבד, אצוות של 6
  const profiles: SharpProfile[] = [];
  for (const pb of chunk(elite, 6)) {
    const res = await llmTry(() => sharpProfiles(pb), failures, "פרופילים");
    if (res) {
      profiles.push(...res);
      calls++;
    }
  }

  // ארכוב אוטומטי: אליטה חיה נכנסת לרשימת הנשמרים עם סימון מפורש — מודיעין שנשמר בין דורות
  let autoSaved = 0;
  let autoSavedSkipped = 0;
  const triageMap = new Map(triage.map((t) => [t.fullName, t]));
  for (const e of elite) {
    try {
      const existing = await db.savedRepo.findUnique({ where: { fullName: e.fullName } });
      const reason = triageMap.get(e.fullName)?.reason?.slice(0, 140) ?? "elite בטריאז׳ה";
      if (!existing) {
        await db.savedRepo.create({
          data: {
            fullName: e.fullName,
            owner: e.fullName.split("/")[0] ?? "",
            name: e.fullName.split("/").slice(1).join("/"),
            url: `https://github.com/${e.fullName}`,
            description: e.description,
            stars: e.stars ?? 0,
            score: Math.min(100, Math.round(e.score ?? 0)),
            models: e.modelStrings?.slice(0, 6).join(",") ?? null,
            evidence: JSON.stringify({ contentEvidence: (e.contentEvidence ?? []).slice(0, 3), tier: e.tierLabel ?? null }),
            notes: `⚔️ ציד חי אוטומטי (#${ctx.id} דור ${ctx.generation}): ${reason}`,
          },
        });
        autoSaved++;
      } else {
        // נשמר ידנית על-ידי המשתמש — לא נוגעים בהערות שלו; סימון ציד קיים יתעדכן בלבד
        if (existing.notes?.includes("ציד חי אוטומטי")) {
          await db.savedRepo.update({
            where: { fullName: e.fullName },
            data: { stars: e.stars ?? existing.stars, score: Math.max(existing.score, Math.min(100, Math.round(e.score ?? 0))) },
          });
          autoSaved++;
        } else {
          autoSavedSkipped++;
        }
      }
    } catch (saveErr) {
      failures.push(`ארכוב אליטה ${e.fullName}: ${saveErr instanceof Error ? saveErr.message : "שגיאה"}`);
    }
  }

  const summary = `${triage.length} נשפטו · ${elite.length} אליטה · ${watch.length} מעקב · ${profiles.length} פרופילים · ${autoSaved} נשמרו אוטומטית${
    failures.length ? ` · ${failures.length} כשלים` : ""
  }`;

  const state: SwarmStageState = { flat, elite, watch, triage, profiles, autoSaved, autoSavedSkipped, llmCalls: calls, llmFailures: failures };
  return { summary, evidence: state as unknown as Record<string, unknown> };
}

// ---------- שלב 3: attack (דפוסים + תקיפה + שאילתות + תדריך) ----------

async function stageAttack(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const swarm = readSwarmState(ctx);
  if (!swarm) throw new LiveHuntError("מצב הלהקה חסר — נדרש שלב swarm", 500);

  const failures: string[] = [];
  let calls = 0;
  const safePatterns: MarketPatterns = { patterns: [], stackConsensus: [], marketShift: "" };

  const patterns =
    (await llmTry(() => patternSynthesis(swarm.elite, swarm.watch), failures, "דפוסים")) ?? safePatterns;
  if (patterns !== safePatterns) calls++;

  const attack =
    (await llmTry(() => attackPlan(swarm.elite, swarm.profiles, patterns), failures, "תוכנית תקיפה")) ?? {
      topMoves: [],
      differentiators: [],
      immediateActions: [],
    };
  if (attack.topMoves.length > 0 || attack.immediateActions.length > 0) calls++;

  const queryEvo =
    (await llmTry(
      () => queryEvolution((readHuntEvidence(ctx)?.executedQueries as string[] | undefined) ?? [], swarm.elite),
      failures,
      "אבולוציית שאילתות"
    )) ?? { nextQueries: [], blindSpots: [], rationale: "" };
  if (queryEvo.nextQueries.length > 0) calls++;

  const brief =
    (await llmTry(
      () =>
        execBrief({
          statsLine: (readHuntEvidence(ctx)?.statsLine as string | undefined) ?? "",
          eliteCount: swarm.elite.length,
          patterns,
          attack,
          dnaAdded: 0,
        }),
      failures,
      "תדריך"
    )) ?? { headline: "לא התקבל תדריך", keyIntel: [], decisiveMove: "", riskMap: failures.slice(0, 3) };
  if (brief.keyIntel.length > 0) calls++;

  const summary = `${patterns.patterns.length} דפוסים · ${attack.topMoves.length} מהלכים · ${queryEvo.nextQueries.length} שאילתות הבאות${
    failures.length ? ` · ${failures.length} כשלי LLM` : ""
  }`;

  const state: AttackStageState = { patterns, attack, queryEvo, brief, llmCalls: calls, llmFailures: failures };
  return { summary, evidence: state as unknown as Record<string, unknown> };
}

// ---------- שלב 4: mine (כריית DNA חיה) ----------

async function stageMine(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const token = await getStoredToken();
  const top = (huntEv?.topCandidates as Candidate[] | undefined) ?? [];
  if (top.length === 0) {
    return {
      summary: "אין מטרות לכרייה — דילוג (הספרייה לא גדלה בשלב זה)",
      evidence: { mined: [], reposMined: 0, dnaAdded: 0 },
    };
  }

  const mined: MinedRepoReport[] = await mineTopCandidates(top, token, 3);
  const reposMined = mined.filter((m) => !m.error).length;
  const dnaAdded = mined.reduce((acc, m) => acc + (m.newCount ?? 0), 0);

  const summary = `${reposMined} מאגרים נכרו · ${dnaAdded} גנים חדשים בספרייה${
    mined.some((m) => m.error) ? ` · ${mined.filter((m) => m.error).length} כישלונות` : ""
  }`;

  return {
    summary,
    evidence: {
      mined: mined.map((m) => ({ repo: m.repo, artifacts: m.artifacts, newCount: m.newCount, updatedCount: m.updatedCount, kinds: m.kinds, error: m.error ?? null })),
      reposMined,
      dnaAdded,
    },
  };
}

// ---------- שלב 5: compile (גזירת מטרה + הידור) ----------

function deriveGoal(swarm: SwarmStageState | null, attack: AttackStageState | null, huntEv: Record<string, unknown> | null): string {
  const a = attack?.attack.immediateActions?.[0] ?? "";
  const m = attack?.attack.topMoves?.[0]?.move ?? "";
  const briefMove = attack?.brief.decisiveMove ?? "";
  const signature = swarm?.profiles?.[0]?.signature ?? "";
  const topName = (huntEv?.topList as { fullName?: string }[] | undefined)?.[0]?.fullName ?? "המטרה המובילה";

  const raw = a || m || briefMove || signature;
  const core = raw.trim().slice(0, 220);
  if (core) {
    return `${core} — מבוסס על המודיעין החי מהציד (מוביל: ${topName})`;
  }
  return `נתח והפק יתרון מהשקעת הפרימיום ב-Claude 5.5+ שנחשפה בציד החי (מוביל: ${topName})`;
}

async function stageCompile(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const swarm = readSwarmState(ctx);
  const attack = readAttackState(ctx);
  const huntEv = readHuntEvidence(ctx);

  const goal = deriveGoal(swarm, attack, huntEv);
  const contextBits: string[] = [];
  if (attack?.patterns.marketShift) contextBits.push(`תזוזת שוק: ${attack.patterns.marketShift.slice(0, 200)}`);
  if (swarm?.elite.length) contextBits.push(`אליטה: ${swarm.elite.map((e) => e.fullName).join(", ").slice(0, 300)}`);
  if (attack?.brief.headline) contextBits.push(`כותרת המערכה: ${attack.brief.headline.slice(0, 150)}`);
  const context = contextBits.join("\n").slice(0, 1200);

  // הספרייה המלאה — כולל הגנים שנולדו בשלב הכרייה שרק נגמר
  const rows = await db.dnaArtifact.findMany({
    select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true, content: true },
  });
  const selected = rankDnaForGoal(goal, rows as DnaRow[], 8);
  const compiled = await compileMission(goal, context, selected);

  if (!compiled.phases || compiled.phases.length === 0) {
    throw new LiveHuntError("התוכנית שהודורה ריקה — אין שלבים לביצוע", 502);
  }

  const mission = await db.mission.create({
    data: {
      goal,
      context: context || null,
      missionName: compiled.missionName,
      status: "compiled",
      plan: JSON.stringify({ oneLiner: compiled.oneLiner, phases: compiled.phases, skillMdSource: compiled.skillMdSource }),
      dnaRefs: JSON.stringify(
        compiled.selectedDna.map((d) => ({ id: d.id, path: d.path, name: d.name, kind: d.kind, sourceRepo: d.sourceRepo }))
      ),
      promptSequence: JSON.stringify(compiled.promptSequence),
      skillMd: compiled.skillMd,
      risks: JSON.stringify(compiled.risks),
      successCriteria: JSON.stringify(compiled.successCriteria),
    },
  });

  const summary = `משימה #${mission.id} ״${compiled.missionName}״ · ${compiled.phases.length} שלבים · ${selected.length} גנים נבחרו · SKILL.md (${compiled.skillMdSource})`;

  return {
    summary,
    evidence: {
      missionId: mission.id,
      missionName: compiled.missionName,
      oneLiner: compiled.oneLiner,
      phases: compiled.phases.map((p: MissionPhase) => p.title),
      dnaRefs: compiled.selectedDna.map((d) => ({ name: d.name, kind: d.kind, sourceRepo: d.sourceRepo, reason: d.reason })),
      skillMdSource: compiled.skillMdSource,
      skillMdLines: compiled.skillMd.split("\n").length,
      risks: compiled.risks.slice(0, 4),
      goal,
      librarySize: rows.length,
    },
  };
}

// ---------- שלב 6: execute (טייס — שלב אחד לכל קריאה, חוזר עד סיום) ----------

async function stageExecute(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown>; stay: boolean }> {
  const compileEv = ctx.evidence("compile");
  const missionId = Number(compileEv?.missionId);
  if (!Number.isInteger(missionId) || missionId <= 0) {
    throw new LiveHuntError("מזהה משימה חסר — נדרש שלב compile", 500);
  }

  const result = await runNextAutopilotPhase(missionId);

  const last = result.state.steps[result.state.steps.length - 1] ?? null;
  const fail = result.failure;
  const preview = last?.deliverable
    ? `${extractHandoff(last.deliverable).slice(0, 240)}`
    : fail
      ? `כשל בשלב: ${fail.error.slice(0, 200)}`
      : "לא בוצע";

  const summary = result.allDone
    ? `הביצוע הושלם: ${result.stepsDone}/${result.totalPhases} שלבים${result.state.failures.length ? ` (${result.state.failures.length} כשלים)` : ""}`
    : `בוצע שלב ${result.stepsDone}/${result.totalPhases} — ממשיכים`;

  return {
    summary,
    evidence: {
      missionId,
      stepsDone: result.stepsDone,
      totalPhases: result.totalPhases,
      allDone: result.allDone,
      failuresCount: result.state.failures.length,
      lastPhaseIndex: last?.phaseIndex ?? fail?.phaseIndex ?? null,
      lastPhaseTitle: last?.title ?? null,
      deliverablePreview: preview,
      deliverableLength: last?.deliverable?.length ?? 0,
    },
    stay: !result.allDone,
  };
}

// ---------- שלב 7: grow (זיקוק שדה → לידת DNA) ----------

function localDistill(input: { outcome: string; notes: string }) {
  const outcomeHeb =
    input.outcome === "success" ? "הצלחה מלאה" : input.outcome === "partial" ? "הצלחה חלקית" : "כישלון";
  const lessons: string[] = [];
  for (const s of input.notes.split(/[\n.!?]+|\.\s/)) {
    const t = s.trim();
    if (t.length >= 12) lessons.push(t);
    if (lessons.length >= 5) break;
  }
  if (lessons.length === 0) {
    lessons.push(
      input.outcome === "failed"
        ? "כישלון הוא נתון: לתעד איפה נתקעו ולחלק את השלב לצעדים קטנים יותר"
        : "לתעד אילו שלבים עברו אימות בקלות — מועמדים ל-DNA במשימות הבאות"
    );
  }
  return {
    verdict: `דיווח שדה (${outcomeHeb}) נשמר — זיקוק AI לא זמין, הלקחים חולצו מקומית`,
    lessons,
    newDna: null,
  };
}

const STATUS_RANK: Record<string, number> = { compiled: 0, in_progress: 1, partial: 2, done: 3, failed: 1 };
const OUTCOME_STATUS: Record<string, string> = { success: "done", partial: "partial", failed: "failed" };

async function stageGrow(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const compileEv = ctx.evidence("compile");
  const missionId = Number(compileEv?.missionId);
  if (!Number.isInteger(missionId) || missionId <= 0) {
    throw new LiveHuntError("מזהה משימה חסר לזיקוק השדה", 500);
  }
  const mission = await db.mission.findUnique({ where: { id: missionId } });
  if (!mission) throw new LiveHuntError(`המשימה #${missionId} נעלמה`, 404);

  const state = parseAutopilotState(mission.autopilot);
  let phaseTitles: string[] = [];
  try {
    const planRaw: unknown = JSON.parse(mission.plan);
    const plan = planRaw && typeof planRaw === "object" ? (planRaw as { phases?: unknown }) : {};
    phaseTitles = Array.isArray(plan.phases)
      ? plan.phases
          .filter((p): p is { title?: unknown } => typeof p === "object" && p !== null)
          .map((p) => (typeof p.title === "string" ? p.title : ""))
          .filter(Boolean)
      : [];
  } catch {
    phaseTitles = [];
  }

  const outcome =
    state.failures.length === 0 ? "success" : state.steps.length > 0 ? "partial" : "failed";
  const lastDeliverable = state.steps[state.steps.length - 1]?.deliverable ?? "";
  const notes =
    `${extractHandoff(lastDeliverable)}\n${state.failures.map((f) => `כשל בשלב ${f.phaseIndex + 1}: ${f.error}`).join("\n")}`
      .trim()
      .slice(0, 3500);

  let distilled: Awaited<ReturnType<typeof distillFieldReport>>;
  let distillMethod: "ai" | "local" = "ai";
  try {
    distilled = await distillFieldReport({ goal: mission.goal, phaseTitles, outcome, notes });
  } catch {
    distilled = localDistill({ outcome, notes });
    distillMethod = "local";
  }

  // לידת DNA מהשדה — עקבי עם מסלול הדיווח הידני (נתיב קבוע מונע התפצלות)
  let bornDnaId: number | null = null;
  if (distilled.newDna) {
    const content = distilled.newDna.content;
    try {
      const created = await db.dnaArtifact.upsert({
        where: {
          sourceRepo_path: {
            sourceRepo: `field:livehunt-${ctx.id}`,
            path: "field/lesson/SKILL.md",
          },
        },
        update: { description: distilled.newDna.description, content, size: content.length },
        create: {
          sourceRepo: `field:livehunt-${ctx.id}`,
          path: "field/lesson/SKILL.md",
          kind: "skill",
          name: distilled.newDna.name || "live-hunt-lesson",
          description: distilled.newDna.description,
          content,
          size: content.length,
        },
      });
      bornDnaId = created.id;
    } catch (dnaErr) {
      console.error("[live-hunt] DNA birth failed (report still saved):", dnaErr);
    }
  }

  // עדכון סטטוס המשימה — רק קדימה, היסטוריית דיווחים נשמרת
  const nextStatus = OUTCOME_STATUS[outcome] ?? mission.status;
  const finalStatus =
    (STATUS_RANK[nextStatus] ?? 0) >= (STATUS_RANK[mission.status] ?? 0) ? nextStatus : mission.status;
  let reportHistory: Array<Record<string, unknown>> = [];
  try {
    const prev: unknown = mission.report ? JSON.parse(mission.report) : null;
    if (Array.isArray(prev)) reportHistory = prev.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    else if (prev && typeof prev === "object") reportHistory = [prev as Record<string, unknown>];
  } catch {
    reportHistory = [];
  }
  const newReport = {
    outcome,
    notes: notes || null,
    verdict: distilled.verdict,
    lessons: distilled.lessons,
    bornDnaId,
    distillMethod,
    source: `livehunt-${ctx.id}`,
    reportedAt: new Date().toISOString(),
  };
  await db.mission.update({
    where: { id: missionId },
    data: { status: finalStatus, report: JSON.stringify([...reportHistory, newReport].slice(-20)) },
  });

  const summary = `${distillMethod === "ai" ? "זוקק ב-AI" : "זיקוק מקומי"} · ${distilled.lessons.length} לקחים${
    bornDnaId ? ` · DNA #${bornDnaId} נולד לספרייה 🧬` : " · ללא DNA חדש"
  }`;

  return {
    summary,
    evidence: {
      missionId,
      outcome,
      distillMethod,
      verdict: distilled.verdict,
      lessons: distilled.lessons,
      bornDnaId,
      bornSource: bornDnaId ? `field:livehunt-${ctx.id}` : null,
      phaseTitles,
      autopilotSteps: state.steps.length,
      autopilotFailures: state.failures.length,
    },
  };
}

// ---------- שלב 8: verdict ----------

async function stageVerdict(ctx: HuntCtx): Promise<{ summary: string; evidence: Record<string, unknown> }> {
  const huntEv = readHuntEvidence(ctx);
  const compileEv = ctx.evidence("compile");
  const growEv = ctx.evidence("grow");
  const mineEv = readMineEvidence(ctx);
  const swarm = readSwarmState(ctx);
  const attack = readAttackState(ctx);

  const [dnaAfter, missionCount] = await Promise.all([
    db.dnaArtifact.count(),
    db.mission.count(),
  ]);

  const bornDnaId = Number(growEv?.bornDnaId) || null;
  const huntEv2 = huntEv as { novelCandidates?: unknown; evolvedQueries?: unknown[]; knownBefore?: unknown } | null;
  const summary = `דור ${ctx.generation} · ${ctx.done.length} שלבים · ${missionCount} משימות בסך הכל · ${ctx.llmCallsSoFar} קריאות LLM`;

  return {
    summary,
    evidence: {
      missionId: Number(compileEv?.missionId) || null,
      missionName: compileEv?.missionName ?? null,
      missionGoal: compileEv?.goal ?? null,
      huntStats: {
        queries: Array.isArray(huntEv?.queries) ? (huntEv?.queries as unknown[]).length : 0,
        candidates: Number(huntEv?.candidates) || 0,
        hardEvidence: Number(huntEv?.hardEvidence) || 0,
        generation: ctx.generation,
        seededFrom: ctx.seededFrom,
        evolvedQueriesRun: Array.isArray(huntEv2?.evolvedQueries) ? huntEv2!.evolvedQueries!.length : 0,
        novelCandidates: typeof huntEv2?.novelCandidates === "number" ? huntEv2.novelCandidates : null,
        novelTop: Array.isArray(huntEv2?.novelTop) ? (huntEv2!.novelTop as Array<Record<string, unknown>>).slice(0, 6) : [],
        knownBefore: Number(huntEv2?.knownBefore) || 0,
      },
      swarm: { elite: swarm?.elite.length ?? 0, watch: swarm?.watch.length ?? 0, llmCalls: swarm?.llmCalls ?? 0, autoSaved: swarm?.autoSaved ?? 0 },
      attack: { topMoves: attack?.attack.topMoves.length ?? 0, nextQueries: attack?.queryEvo.nextQueries.length ?? 0, llmCalls: attack?.llmCalls ?? 0 },
      briefHeadline: attack?.brief.headline ?? null,
      decisiveMove: attack?.brief.decisiveMove ?? null,
      mine: { reposMined: Number(mineEv?.reposMined) || 0, dnaAdded: Number(mineEv?.dnaAdded) || 0 },
      growth: {
        bornDnaId,
        bornSource: growEv?.bornSource ?? null,
        lessons: growEv?.lessons ?? [],
        distillMethod: growEv?.distillMethod ?? null,
      },
      totals: {
        dnaAfter,
        missionCount,
        // מקור אמת יחיד: המונה המצטבר בשורת הציד (בעבר: נוסחה מקומית שסתרה את המונה)
        llmCalls: ctx.llmCallsSoFar,
      },
    },
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- מנוע המדינה (state machine) ----------

export async function startLiveHunt(): Promise<{ id: number }> {
  // ריצה פעילה אחת בלבד — ריצה שלא עודכנה 15 דקות נחשבת מתה
  const staleCutoff = new Date(Date.now() - 15 * 60_000);
  await db.liveHunt.updateMany({
    where: { status: "running", updatedAt: { lt: staleCutoff } },
    data: { status: "failed", error: "הריצה נקטעה (השרת אותחל) — סימון אוטומטי" },
  });
  const active = await db.liveHunt.findFirst({ where: { status: "running" }, select: { id: true } });
  if (active) {
    throw new LiveHuntError("ציד חי כבר רץ כרגע — חכה לסיומו", 409);
  }
  const dnaBefore = await db.dnaArtifact.count();
  // דור גנרציוני: כל ציד חדש הוא דור+1 מהציד המוצלח האחרון — הבן צד עם שאילתות האבולוציה של האב
  const prevDone = await db.liveHunt.findFirst({ where: { status: "done" }, orderBy: { id: "desc" }, select: { id: true, generation: true } });
  const generation = (prevDone?.generation ?? 0) + 1;
  const seededFrom = prevDone?.id ?? null;
  const hunt = await db.liveHunt.create({
    data: { status: "running", stageKey: "hunt", dnaBefore, generation, seededFrom },
  });
  return { id: hunt.id };
}

export interface LiveHuntState {
  id: number;
  status: string;
  stageKey: string;
  done: boolean;
  goal: string;
  missionId: number | null;
  generation: number;
  seededFrom: number | null;
  dnaBefore: number;
  dnaAfter: number;
  llmCalls: number;
  elapsedMs: number;
  error: string | null;
  stages: LiveHuntStageRecord[];
  stageOrder: readonly string[];
}

export function serializeLiveHunt(row: {
  id: number;
  status: string;
  stageKey: string;
  stages: string | null;
  goal: string;
  missionId: number | null;
  generation: number;
  seededFrom: number | null;
  dnaBefore: number;
  dnaAfter: number;
  llmCalls: number;
  elapsedMs: number;
  error: string | null;
}): LiveHuntState {
  const stages = safeJsonParse<LiveHuntStageRecord[]>(row.stages ?? "[]", []).filter(
    (s) => s && typeof s.key === "string"
  );
  return {
    id: row.id,
    status: row.status,
    stageKey: row.stageKey,
    done: row.status === "done",
    goal: row.goal,
    missionId: row.missionId ?? null,
    generation: row.generation,
    seededFrom: row.seededFrom ?? null,
    dnaBefore: row.dnaBefore,
    dnaAfter: row.dnaAfter,
    llmCalls: row.llmCalls,
    elapsedMs: row.elapsedMs,
    error: row.error,
    stages,
    stageOrder: LIVE_HUNT_STAGE_ORDER,
  };
}

/**
 * הרצת השלב הבא. נעילה פר-ריצה — קריאות מקבילות מתורגמות לרצף.
 * שלב execute חוזר על עצמו עד שכל שלבי המשימה בוצעו.
 */
const huntLocks = new Map<number, Promise<unknown>>();

export function runNextLiveHuntStage(id: number): Promise<LiveHuntState> {
  const prev = huntLocks.get(id) ?? Promise.resolve();
  const gate = prev.catch(() => undefined).then(() => runNextLocked(id));
  huntLocks.set(id, gate);
  void gate.catch(() => undefined).finally(() => {
    if (huntLocks.get(id) === gate) huntLocks.delete(id);
  });
  return gate;
}

async function runNextLocked(id: number): Promise<LiveHuntState> {
  const row = await db.liveHunt.findUnique({ where: { id } });
  if (!row) throw new LiveHuntError("הציד לא נמצא", 404);
  if (row.status === "done") return serializeLiveHunt(row);

  const startedAt = Date.now();
  const doneStages = safeJsonParse<LiveHuntStageRecord[]>(row.stages ?? "[]", []).filter(
    (s) => s && typeof s.key === "string"
  );
  const ctx: HuntCtx = {
    id,
    done: doneStages,
    evidence: (key) => doneStages.find((s) => s.key === key)?.evidence ?? null,
    llmCallsSoFar: row.llmCalls,
    generation: row.generation,
    seededFrom: row.seededFrom ?? null,
  };

  const stageKey = row.stageKey;
  const title = LIVE_HUNT_STAGE_TITLES[stageKey] ?? stageKey;

  try {
    let result: { summary: string; evidence: Record<string, unknown>; stay?: boolean };
    switch (stageKey) {
      case "hunt":
        result = await stageHunt(ctx);
        break;
      case "swarm":
        result = await stageSwarm(ctx);
        break;
      case "attack":
        result = await stageAttack(ctx);
        break;
      case "mine":
        result = await stageMine(ctx);
        break;
      case "compile":
        result = await stageCompile(ctx);
        break;
      case "execute":
        result = await stageExecute(ctx);
        break;
      case "grow":
        result = await stageGrow(ctx);
        break;
      case "verdict":
        result = await stageVerdict(ctx);
        break;
      default:
        throw new LiveHuntError(`שלב לא מוכר: ${stageKey}`, 400);
    }

    const rec: LiveHuntStageRecord = {
      key: stageKey,
      title,
      summary: result.summary,
      ms: Date.now() - startedAt,
      evidence: result.evidence,
    };

    // execute חוזר — מחליף את הרשומה הקיימת במקום להצטבר
    const newDone = result.stay
      ? [...doneStages.filter((s) => s.key !== stageKey), rec]
      : [...doneStages, rec];

    let nextStageKey: string;
    if (result.stay) {
      nextStageKey = stageKey; // נשארים על execute עד סיום כל השלבים
    } else {
      const idx = LIVE_HUNT_STAGE_ORDER.indexOf(stageKey as (typeof LIVE_HUNT_STAGE_ORDER)[number]);
      nextStageKey = idx >= 0 && idx + 1 < LIVE_HUNT_STAGE_ORDER.length ? LIVE_HUNT_STAGE_ORDER[idx + 1] : "done";
    }

    // עדכון missionId כשנודע, goal כשנגזר
    const missionIdFromEvidence = Number(result.evidence.missionId);
    const goalFromEvidence = typeof result.evidence.goal === "string" ? (result.evidence.goal as string) : null;

    const isFinished = nextStageKey === "done" && stageKey === "verdict";
    const dnaAfter = isFinished ? await db.dnaArtifact.count() : row.dnaAfter;
    const llmDelta =
      stageKey === "swarm" || stageKey === "attack"
        ? Number(result.evidence.llmCalls) || 0
        : ["compile", "execute", "grow"].includes(stageKey)
          ? stageKey === "compile"
            ? 2
            : 1
          : 0;

    const updated = await db.liveHunt.update({
      where: { id },
      data: {
        stages: JSON.stringify(newDone),
        stageKey: isFinished ? "verdict" : nextStageKey,
        status: isFinished ? "done" : "running",
        missionId: Number.isInteger(missionIdFromEvidence) && missionIdFromEvidence > 0 ? missionIdFromEvidence : row.missionId,
        goal: goalFromEvidence ?? row.goal,
        dnaAfter,
        llmCalls: row.llmCalls + llmDelta,
        elapsedMs: row.elapsedMs + rec.ms,
      },
    });

    const state = serializeLiveHunt(updated);
    if (isFinished) {
      // מסקנת המערכה — הצמיחה מוכחת במספרים
      state.done = true;
    }
    return state;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "שגיאה לא ידועה";
    const failed = await db.liveHunt.update({
      where: { id },
      data: { status: "failed", error: msg.slice(0, 500) },
    });
    console.error(`[live-hunt] stage ${stageKey} failed for hunt #${id}:`, e);
    // AutopilotError עם 4xx = בעיה מובנית — מוחזר כפי שהוא; אחרת שגיאת שרת
    const status = e instanceof LiveHuntError ? e.status : e instanceof AutopilotError ? e.status : 500;
    const err = new LiveHuntError(msg, status || 500);
    // עדיין מחזירים את המצב המלא בשדה של השגיאה דרך ה-API
    throw Object.assign(err, { state: serializeLiveHunt(failed) });
  }
}

/** ניסיון חוזר על השלב הנוכחי אחרי כשל */
export async function retryLiveHunt(id: number): Promise<LiveHuntState> {
  const row = await db.liveHunt.findUnique({ where: { id } });
  if (!row) throw new LiveHuntError("הציד לא נמצא", 404);
  if (row.status !== "failed") throw new LiveHuntError("רק ציד שנכשל יכול להינסות שוב", 400);
  const updated = await db.liveHunt.update({
    where: { id },
    data: { status: "running", error: null },
  });
  return serializeLiveHunt(updated);
}
