import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { distillFieldReport, MissionError } from "@/lib/mission-compiler";
import { isTimeoutError, isPrismaNotFound } from "@/lib/ai-json";
import { advanceStatus, OUTCOME_STATUS } from "@/lib/mission-status";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** ניקוי מטא-דאטה שנולדה מה-AI לפני שמירתה בספרייה — השם/התיאור של DNA
 * נכנסים לפרומפטים של מהדר/מבצע בעתיד; תווי בקרה וגדרות שם זו דלת
 * הזרקת-הוראות (בעבר: שדה חופשי לגמרי). */
function sanitizeBornMeta(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[<>`\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * מזקק מקומי (בלי AI) — רשת ביטחון קריטית:
 * הדיווח מהשדה הוא נתון יקר שנאסף מהעבודה האמיתית. בעבר, כשיחת ה-AI נפלה
 * (timeout/רשת) — כל הדיווח הושלך עם 500. עכשיו הלולאה תמיד נשמרת,
 * עם לקחים היוריסטיים עד שזיקוק AI יוכל לרוץ שוב.
 */
function localDistill(input: { outcome: string; notes: string }) {
  const outcomeHeb =
    input.outcome === "success" ? "הצלחה מלאה" : input.outcome === "partial" ? "הצלחה חלקית" : "כישלון";
  const lessons: string[] = [];
  // פיצול הערות למשפטים — כל משפט מועמד ללקח
  for (const s of input.notes.split(/[\n.!?]+|\.\s/)) {
    const t = s.trim();
    if (t.length >= 12) lessons.push(t);
    if (lessons.length >= 5) break;
  }
  if (lessons.length === 0) {
    lessons.push(
      input.outcome === "failed"
        ? "כישלון הוא נתון: לתעד איפה בדיוק נתקע ולחלק את השלב הנכשל לצעדים קטנים יותר בפעם הבאה"
        : "לתעד אילו שלבים עברו אימות בקלות — הם המועמדים לשימוש חוזר כ-DNA במשימות הבאות"
    );
  }
  return {
    verdict: `דיווח שדה (${outcomeHeb}) נשמר — זיקוק AI לא זמין כרגע, הלקחים חולצו מקומית מההערות`,
    lessons,
    newDna: null,
  };
}

/** סטטוס רק קדימה — דיווח שדה לא מדרג משימה שהגיעה כבר ל-done אחורה
 * (הועבר ל-mission-status — בעבר הוגדר מחדש כאן ובשני קבצים נוספים) */

/**
 * דיווח שדה — הלולאה המאבולוציונית:
 * דיווח ← זיקוק AI ללקחים ← לידת DNA חדש בספרייה (sourceRepo: field:mission-<id>)
 * כך כל משימה שמבוצעת מחכימה את הספרייה למשימות הבאות.
 * הדיווח עצמו תמיד נשמר — גם כשזיקוק ה-AI נכשל (fallback מקומי),
 * וגם כששמירת DNA נכשלת (הדיווח קודם ל-DNA — סדר שמירה שלא מאבד נתונים).
 */
export async function POST(req: NextRequest) {
  let missionId = 0;
  let outcome = "";
  let notes = "";
  try {
    const body = (await req.json()) as { missionId?: unknown; outcome?: unknown; notes?: unknown };
    // (בעבר: Number(null) === 0 עבר את הבדיקה ונחתך ל-404; כעת בדיקת טיפוס מפורשת → 400)
    missionId = typeof body.missionId === "number" ? body.missionId : Number.NaN;
    outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
    notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  } catch {
    return NextResponse.json({ error: "גוף הבקשה אינו תקין" }, { status: 400 });
  }
  if (!Number.isInteger(missionId) || missionId <= 0 || !["success", "partial", "failed"].includes(outcome)) {
    return NextResponse.json({ error: "נדרש מזהה משימה ותוצאה (success | partial | failed)" }, { status: 400 });
  }

  try {
    const mission = await db.mission.findUnique({ where: { id: missionId } });
    if (!mission) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });

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

    // זיקוק AI עם נפילה מבוקרת למקומי — הדיווח לא נזרק לעולם
    let distilled: Awaited<ReturnType<typeof distillFieldReport>>;
    let distillMethod: "ai" | "local" = "ai";
    try {
      distilled = await distillFieldReport({
        goal: mission.goal,
        phaseTitles,
        outcome,
        notes,
      });
    } catch (distillErr) {
      // timeout לא מנוסה שוב בפנים; כאן זה כבר סופי — שומרים מקומית
      if (!(distillErr instanceof MissionError) && !isTimeoutError(distillErr) && distillErr instanceof Error) {
        // שגיאה לא צפויה — לוג לשרת, אבל עדיין שומרים את הדיווח
        console.error("[mission/report] distill failed unexpectedly:", distillErr.message);
      }
      distilled = localDistill({ outcome, notes });
      distillMethod = "local";
    }

    // ---- סדר שמירה בטרנזקציה אחת + CAS ----
    // בעבר: upsert DNA (רשומה ראשונה) ואז mission.update בכתיבה נפרדת —
    //   1) כשל עדכון השאיר DNA יתום והשליך את הדיווח (ההפך מההערה שלמעלה).
    //   2) שני טאבים קראו את אותו report ישן — השני דרס את דיווח הראשון (lost update).
    // עכשיו: קריאה מחדש בתוך הטרנזקציה + updateMany מותנה (compare-and-swap על
    // status+report) — אם מישהו כתב בינתיים, זה זורק REPORT_CHANGED_RETRY
    // והלולאה מנסה שוב מערך טרי. ההרכה עצמה עדיין "דיווח קודם": כשל upsert DNA
    // בתוך הטרנזקציה לא מפיל אותה (dnaBirthError נרשם במקום bornDnaId).
    let lastErrFinal: unknown = null;
    let savedDnaBirthError: string | null = null;
    let savedBornDnaId: number | null = null;
    let savedFinalStatus = mission.status;
    let savedHistoryCount = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let bornDnaId: number | null = null;
        let dnaBirthError: string | null = null;
        await db.$transaction(async (tx) => {
          // לידת DNA בתוך הטרנזקציה — כישלון לידה לא מפיל את הדיווח (נשמר כשגיאה גלויה)
          if (distilled.newDna) {
            try {
              const desc = sanitizeBornMeta(distilled.newDna.description, 200);
              const content = distilled.newDna.content;
              const created = await tx.dnaArtifact.upsert({
                where: {
                  sourceRepo_path: {
                    sourceRepo: `field:mission-${missionId}`,
                    path: "field/lesson/SKILL.md",
                  },
                },
                update: { description: desc, content, size: content.length },
                create: {
                  sourceRepo: `field:mission-${missionId}`,
                  path: "field/lesson/SKILL.md",
                  kind: "skill",
                  // השם נכנס לפרומפטים עתידיים — מנוקה וקצוץ (בעבר: שדה חופשי)
                  name: sanitizeBornMeta(distilled.newDna.name, 60) || "field-lesson",
                  description: desc,
                  content,
                  size: content.length,
                },
              });
              bornDnaId = created.id;
            } catch (dnaErr) {
              dnaBirthError = dnaErr instanceof Error ? dnaErr.message : "שגיאה";
              console.error("[mission/report] DNA birth failed (report still saved):", dnaErr);
            }
          }

          // קריאה מחדש בתוך הטרנזקציה — מי שכתב בינתיים נכנס ל-history שלנו, לא נדרס
          const fresh = await tx.mission.findUnique({
            where: { id: missionId },
            select: { status: true, report: true },
          });
          if (!fresh) throw new MissionError("המשימה נעלמה במהלך הדיווח");

          const nextStatus = OUTCOME_STATUS[outcome] ?? fresh.status;
          const finalStatus = advanceStatus(fresh.status, nextStatus);

          let reportHistory: Array<Record<string, unknown>> = [];
          try {
            const prev: unknown = fresh.report ? JSON.parse(fresh.report) : null;
            if (Array.isArray(prev)) {
              reportHistory = prev.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
            } else if (prev && typeof prev === "object") {
              reportHistory = [prev as Record<string, unknown>];
            }
          } catch {
            reportHistory = [];
          }

          const newReport = {
            outcome,
            notes: notes || null,
            verdict: distilled.verdict,
            lessons: distilled.lessons,
            bornDnaId,
            dnaBirthError,
            distillMethod,
            reportedAt: new Date().toISOString(),
          };
          const finalReportJson = JSON.stringify([...reportHistory, newReport].slice(-20));

          // CAS: אם status/report השתנו מחוץ לטרנזקציה — נזרקים ומנסים שוב על ערך טרי
          const cas = await tx.mission.updateMany({
            where: { id: missionId, status: fresh.status, report: fresh.report ?? "" },
            data: { status: finalStatus, report: finalReportJson },
          });
          if (cas.count === 0) {
            const err = new Error("REPORT_CHANGED_RETRY");
            err.name = "ReportChangedRetry";
            throw err;
          }
          savedBornDnaId = bornDnaId;
          savedDnaBirthError = dnaBirthError;
          savedFinalStatus = finalStatus;
          savedHistoryCount = reportHistory.length + 1;
        });
        break;
      } catch (txErr) {
        if (txErr instanceof Error && txErr.name === "ReportChangedRetry" && attempt < 2) {
          continue; // מישהו כתב בינתיים — לולאה חדשה על ערך טרי
        }
        lastErrFinal = txErr;
        break;
      }
    }
    if (lastErrFinal) throw lastErrFinal;

    return NextResponse.json({
      ok: true,
      distillMethod,
      verdict: distilled.verdict,
      lessons: distilled.lessons,
      bornDna: distilled.newDna
        ? savedBornDnaId
          ? { id: savedBornDnaId, name: sanitizeBornMeta(distilled.newDna.name, 60) || "field-lesson", description: sanitizeBornMeta(distilled.newDna.description, 200) }
          : { id: null, birthError: savedDnaBirthError }
        : null,
      finalStatus: savedFinalStatus,
      historyCount: savedHistoryCount,
    });
  } catch (e) {
    if (isPrismaNotFound(e)) {
      return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
    }
    // (בעבר: e.message גולמי דלף ללקוח; כעת לוג מלא בשרת + הודעה גנרית)
    console.error("[mission/report]", e);
    return NextResponse.json({ error: "זיקוק הדיווח נכשל" }, { status: 500 });
  }
}
