import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { distillFieldReport, MissionError } from "@/lib/mission-compiler";
import { isTimeoutError, isPrismaNotFound } from "@/lib/ai-json";
import { advanceStatus, OUTCOME_STATUS } from "@/lib/mission-status";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Sanitize AI-born metadata before saving it to the library — a DNA's name/description
 * enters future compiler/executor prompts; control characters and name fences are an
 * instruction-injection door (previously: a completely free-form field). */
function sanitizeBornMeta(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[<>`\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Local distillation (no AI) — a critical safety net:
 * a field report is precious data collected from real work. Previously, when the AI chat failed
 * (timeout/network) — the entire report was discarded with a 500. Now the loop is always saved,
 * with heuristic lessons until AI distillation can run again.
 */
function localDistill(input: { outcome: string; notes: string }) {
  const outcomeHeb =
    input.outcome === "success" ? "full success" : input.outcome === "partial" ? "partial success" : "failure";
  const lessons: string[] = [];
  // Split the notes into sentences — each sentence is a lesson candidate
  for (const s of input.notes.split(/[\n.!?]+|\.\s/)) {
    const t = s.trim();
    if (t.length >= 12) lessons.push(t);
    if (lessons.length >= 5) break;
  }
  if (lessons.length === 0) {
    lessons.push(
      input.outcome === "failed"
        ? "Failure is data: document exactly where it got stuck and split the failed stage into smaller steps next time"
        : "Document which stages passed verification easily — they are the candidates for reuse as DNA in future missions"
    );
  }
  return {
    verdict: `Field report (${outcomeHeb}) saved — AI distillation unavailable right now, lessons extracted locally from the notes`,
    lessons,
    newDna: null,
  };
}

/** Forward-only status — a field report does not demote a mission that already reached done
 * (moved to mission-status — previously redefined here and in two other files) */

/**
 * Field report — the evolutionary loop:
 * report ← AI distillation into lessons ← birth of new DNA in the library (sourceRepo: field:mission-<id>)
 * This way every executed mission makes the library smarter for future missions.
 * The report itself is always saved — even when AI distillation fails (local fallback),
 * and even when saving the DNA fails (the report precedes the DNA — a save order that loses no data).
 */
export async function POST(req: NextRequest) {
  let missionId = 0;
  let outcome = "";
  let notes = "";
  try {
    const body = (await req.json()) as { missionId?: unknown; outcome?: unknown; notes?: unknown };
    // (Previously: Number(null) === 0 passed the check and was cut to a 404; now: an explicit type check → 400)
    missionId = typeof body.missionId === "number" ? body.missionId : Number.NaN;
    outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
    notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!Number.isInteger(missionId) || missionId <= 0 || !["success", "partial", "failed"].includes(outcome)) {
    return NextResponse.json({ error: "A mission identifier and an outcome are required (success | partial | failed)" }, { status: 400 });
  }

  try {
    const mission = await db.mission.findUnique({ where: { id: missionId } });
    if (!mission) return NextResponse.json({ error: "Mission not found" }, { status: 404 });

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

    // AI distillation with a controlled fall back to local — the report is never thrown away
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
      // The timeout is not retried inside; here it is already final — save locally
      if (!(distillErr instanceof MissionError) && !isTimeoutError(distillErr) && distillErr instanceof Error) {
        // An unexpected error — log to the server, but still save the report
        console.error("[mission/report] distill failed unexpectedly:", distillErr.message);
      }
      distilled = localDistill({ outcome, notes });
      distillMethod = "local";
    }

    // ---- Save order in a single transaction + CAS ----
    // Previously: a DNA upsert (first record) and then mission.update in a separate write —
    //   1) an update failure left orphaned DNA and discarded the report (the opposite of the comment above).
    //   2) two tabs read the same old report — the second overwrote the first's report (lost update).
    // Now: a re-read inside the transaction + a conditional updateMany (compare-and-swap on
    // status+report) — if someone wrote in the meantime, it throws REPORT_CHANGED_RETRY
    // and the loop retries on a fresh value. The composition itself is still "report first": a DNA upsert
    // failure inside the transaction does not fail it (dnaBirthError is recorded instead of bornDnaId).
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
          // DNA birth inside the transaction — a birth failure does not fail the report (saved as an explicit error)
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
                  // The name enters future prompts — sanitized and capped (previously: a free-form field)
                  name: sanitizeBornMeta(distilled.newDna.name, 60) || "field-lesson",
                  description: desc,
                  content,
                  size: content.length,
                },
              });
              bornDnaId = created.id;
            } catch (dnaErr) {
              dnaBirthError = dnaErr instanceof Error ? dnaErr.message : "Error";
              console.error("[mission/report] DNA birth failed (report still saved):", dnaErr);
            }
          }

          // Re-read inside the transaction — whoever wrote in the meantime goes into our history, not overwritten
          const fresh = await tx.mission.findUnique({
            where: { id: missionId },
            select: { status: true, report: true },
          });
          if (!fresh) throw new MissionError("The mission disappeared during the report");

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

          // CAS: if status/report changed outside the transaction — thrown out and retried on a fresh value
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
          continue; // someone wrote in the meantime — a new loop on a fresh value
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
      return NextResponse.json({ error: "Mission not found" }, { status: 404 });
    }
    // (Previously: a raw e.message leaked to the client; now: a full server log + generic message)
    console.error("[mission/report]", e);
    return NextResponse.json({ error: "Report distillation failed" }, { status: 500 });
  }
}
