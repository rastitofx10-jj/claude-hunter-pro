// ============================================================
// מנוע הטייס האוטומטי — ביצוע שלב-אחר-שלב עם שמירה מצטברת.
// למה צעד-צעד ולא בקשה אחת גדולה? ראיות:
// 1. בקשה מלאה = עד 4×110 שניות עיוורות; הלקוח/שער עלולים לנתק — והתוצר אובד.
// 2. שמירה אחרי כל שלב = ריסטרט דפדפן לא מפיל את הריצה; ממשיכים מהשלב הבא.
// 3. הלקוח רואה התקדמות אמיתית פר-שלב במקום spinner של 3 דקות.
// מקור לוגיקה יחיד — משמש גם את endpoint הצעד וגם את הריצה המלאה ההיסטורית.
// פועל בצד שרת בלבד.
// ============================================================

import { db } from "@/lib/db";
import { safeJsonParse, isTimeoutError } from "./ai-json";
import { executePhase, extractHandoff, type AutopilotStep, type MissionPhase } from "./mission-compiler";
import { advanceStatus } from "./mission-status";

export interface AutopilotFailure {
  phaseIndex: number;
  error: string;
  /** כשל חולף (timeout/תור עמוס) — יינסה שוב בקריאת הצעד הבאה, עד ניסיון נוסף אחד */
  transient?: boolean;
  /** מספר ניסיונות שנכשלו לשלב זה (נשמר בכתיבה בכל פעם מחדש — 1 לכישלון ראשון) */
  attempts?: number;
}

export interface AutopilotState {
  steps: AutopilotStep[];
  failures: AutopilotFailure[];
}

export interface NextPhaseResult {
  done: boolean; // כל השלבים בוצעו (או נכשלו)
  allDone: boolean; // אין עוד שלב ממתין
  executed: AutopilotStep | null;
  failure: AutopilotFailure | null;
  stepsDone: number;
  totalPhases: number;
  state: AutopilotState;
}

/** טעינת מצב טייס סלחנית — תומך גם בפורמט ההיסטורי (failures כמחרוזות).
 * deliverable מובטח כמחרוזת — שורות היסטוריות בלי deliverable לא מפילות את ה-UI
 * (בעבר: s.deliverable.length קרס על undefined). */
export function parseAutopilotState(raw: string | null): AutopilotState {
  const parsed = safeJsonParse<{ steps?: AutopilotStep[]; failures?: (AutopilotFailure | string)[] }>(raw, {});
  const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
    .filter((s) => s && typeof s.phaseIndex === "number")
    .map((s) => ({
      phaseIndex: s.phaseIndex,
      title: typeof s.title === "string" ? s.title : `שלב ${s.phaseIndex + 1}`,
      deliverable: typeof s.deliverable === "string" ? s.deliverable : "",
      executedAt: typeof s.executedAt === "string" ? s.executedAt : new Date(0).toISOString(),
    }));
  const failures = (Array.isArray(parsed.failures) ? parsed.failures : [])
    .map((f): AutopilotFailure | null => {
      if (typeof f === "string") {
        // פורמט היסטורי: "שלב 2 (כותרת): הודעה"
        const m = f.match(/שלב (\d+)/);
        return { phaseIndex: m ? Number(m[1]) - 1 : -1, error: f, transient: false, attempts: 2 };
      }
      return f && typeof f.phaseIndex === "number"
        ? {
            phaseIndex: f.phaseIndex,
            error: String(f.error ?? "שגיאה"),
            transient: !!f.transient,
            attempts: typeof f.attempts === "number" ? f.attempts : 2,
          }
        : null;
    })
    .filter((f): f is AutopilotFailure => !!f);
  return { steps, failures };
}

export class AutopilotError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "AutopilotError";
    this.status = status;
  }
}

/**
 * נעילה פר-משימה בתהליך: שתי קריאות צעד מקבילות (דאבל-קליק / שני טאבים)
 * בלי זה — שתיהן קוראות את אותו מצב ומבצעות את אותו שלב פעמיים
 * (עבודת LLM כפולה ו-clobber של ה-state). עכשיו השנייה ממתינה ואז קוראת מצב טרי.
 */
const missionLocks = new Map<number, Promise<unknown>>();

async function withMissionLock<T>(missionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = missionLocks.get(missionId) ?? Promise.resolve();
  const gate = prev.catch(() => undefined).then(fn);
  missionLocks.set(missionId, gate);
  try {
    return await gate;
  } finally {
    if (missionLocks.get(missionId) === gate) missionLocks.delete(missionId);
  }
}

/**
 * הרצת השלב הבא שטרם בוצע במשימה + שמירה מיידית של התוצאה.
 * מחזיר מה בוצע (או איזה שלב נכשל), ואת המצב המלא אחרי השלב.
 * מוגן בנעילה פר-משימה — קריאות מקבילות מתורגמות לרצף.
 */
export function runNextAutopilotPhase(missionId: number): Promise<NextPhaseResult> {
  return withMissionLock(missionId, () => runNextAutopilotPhaseLocked(missionId));
}

async function runNextAutopilotPhaseLocked(missionId: number): Promise<NextPhaseResult> {
  const mission = await db.mission.findUnique({ where: { id: missionId } });
  if (!mission) throw new AutopilotError("המשימה לא נמצאה", 404);

  const planRaw = safeJsonParse<{ phases?: MissionPhase[] } | null>(mission.plan, null);
  const plan = planRaw ?? {}; // "null" ב-DB → null → נגן נגד crash
  const phases = (Array.isArray(plan.phases) ? plan.phases : []).filter(
    (p) => p && typeof p.title === "string"
  );
  if (phases.length === 0) throw new AutopilotError("למשימה אין שלבים לביצוע", 400);

  const state = parseAutopilotState(mission.autopilot);
  const executedIdx = new Set(state.steps.map((s) => s.phaseIndex));
  // כשל צמית = שלב שנכשל שלא-חולף, או חולף שכבר בזבז את ניסיון החזרה שלו.
  // בעבר: timeout בודד סימן את השלב ככישלון צמיתות — nextIdx דילג עליו לנצח
  // ולא היה שום מנגנון שחזור; המשימה נשארה חלקית לצמיתות.
  const failedIdxPermanent = new Set(
    state.failures
      .filter((f) => !f.transient || (f.attempts ?? 2) >= 2)
      .map((f) => f.phaseIndex),
  );
  const nextIdx = phases.findIndex((_, i) => !executedIdx.has(i) && !failedIdxPermanent.has(i));

  if (nextIdx === -1) {
    // הכל בוצע — נוודא שהסטטוס משקף (נשאר in_progress עד דיווח שדה)
    return {
      done: true,
      allDone: true,
      executed: null,
      failure: null,
      stepsDone: state.steps.length,
      totalPhases: phases.length,
      state,
    };
  }

  // ה-DNA שנבחר בהידור — תוכן מלא לביצוע. המבצע ממילא משתמש ב-6 הראשונים
  // (executePhase: slice(0,6)) — בעבר נטענו כל 8 השורות כולל התוכן המלא
  // של שתיים שלא הגיעו לאף פרומפט (השקעת DB לחינם).
  const dnaRefs = safeJsonParse<{ id: number }[]>(mission.dnaRefs, []);
  const ids = dnaRefs.map((d) => d.id).filter((n) => Number.isInteger(n)).slice(0, 6);
  const dnaRows = ids.length
    ? await db.dnaArtifact.findMany({
        where: { id: { in: ids } },
        select: { id: true, sourceRepo: true, path: true, kind: true, name: true, description: true, content: true },
      })
    : [];

  // שרשור Handoffs מהשלבים שכבר בוצעו — בסדר שלב אמיתי
  const priorOutputs = state.steps
    .slice()
    .sort((a, b) => a.phaseIndex - b.phaseIndex)
    .map((s) => ({ title: s.title, handoff: extractHandoff(s.deliverable) }));

  if (mission.status === "compiled") {
    await db.mission.update({ where: { id: missionId }, data: { status: "in_progress" } });
  }

  const phase = phases[nextIdx];
  let executed: AutopilotStep | null = null;
  let failResult: AutopilotFailure | null = null;

  try {
    const deliverable = await executePhase({
      goal: mission.goal,
      phase,
      phaseIndex: nextIdx,
      priorOutputs,
      dna: dnaRows,
    });
    executed = { phaseIndex: nextIdx, title: phase.title, deliverable, executedAt: new Date().toISOString() };
  } catch (e) {
    const transient = isTimeoutError(e);
    const prevAttempts = state.failures.find((f) => f.phaseIndex === nextIdx)?.attempts ?? 0;
    failResult = {
      phaseIndex: nextIdx,
      error: e instanceof Error ? e.message : "שגיאה לא ידועה",
      // transient=true → הצעד הבא ינסה את השלב שוב (עד attempts=2). בעבר: timeout
      // בודד חיסל את השלב לצמיתות — המשימה נתקעה חלקית בלי דרך שחזור.
      transient,
      attempts: prevAttempts + 1,
    };
  }

  // רשומת כישלון אחת לשלב (האחרונה מנצחת) — ניסיון חוזר לא מצטבר שורות כפולות
  const failureMap = new Map(state.failures.map((f) => [f.phaseIndex, f]));
  if (failResult) failureMap.set(failResult.phaseIndex, failResult);
  const newState: AutopilotState = {
    steps: executed ? [...state.steps, executed] : state.steps,
    failures: [...failureMap.values()].sort((a, b) => a.phaseIndex - b.phaseIndex),
  };

  // האם אחרי השלב הזה אין יותר שלבים ממתינים?
  const nowExecuted = new Set(newState.steps.map((s) => s.phaseIndex));
  const nowFailed = new Set(newState.failures.map((f) => f.phaseIndex));
  const allDone = phases.every((_, i) => nowExecuted.has(i) || nowFailed.has(i));

  // סטטוס: כשלים מלאים = failed; אחרת נשאר in_progress עד דיווח השדה.
  // חוק מעבר חד-כיווני: partial/done לא מדורגים אחורה ל-in_progress
  // (בעבר: ריצת טייס מחדש על משימה חלקית/גמורה דרכה אחורה)
  const computed =
    allDone && newState.steps.length === 0 && newState.failures.length > 0 ? "failed" : "in_progress";
  // מפתח המירוץ: mission.status נקרא בראש הפונקציה — לפני עד 220 שניות של
  // executePhase. דיווח שדה שהסתיים במקביל (status → done) נרמס ל-in_progress
  // ע"י הכתיבה הזו. עכשיו: קריאה מחדש בתוך הנעילה, מיד לפני הכתיבה.
  const fresh = await db.mission.findUnique({ where: { id: missionId }, select: { status: true } });
  const currentStatus = fresh?.status ?? mission.status;
  const status = advanceStatus(currentStatus, computed);

  await db.mission.update({
    where: { id: missionId },
    data: { autopilot: JSON.stringify(newState), autopilotAt: new Date(), status },
  });

  return {
    done: false,
    allDone,
    executed,
    failure: failResult,
    stepsDone: newState.steps.length,
    totalPhases: phases.length,
    state: newState,
  };
}
