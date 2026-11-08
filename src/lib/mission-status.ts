// ============================================================
// חוק הסטטוסים של משימות — מקור יחיד.
// בעבר היה מוגדר-מחדש בשלושה קבצים (autopilot, report route, live-hunt)
// ואחד מהם כבר סטה מהשאר — חוק אחד, מקור אחד.
// פועל בצד שרת בלבד.
// ============================================================

/** דירוג סטטוס: המספר גבוה יותר = מתקדם יותר. מעבר סטטוס מותר רק קדימה. */
export const STATUS_RANK: Record<string, number> = {
  compiled: 0,
  in_progress: 1,
  partial: 2,
  done: 3,
  failed: 1,
};

/** מיפוי תוצאת-שדה → סטטוס משימה */
export const OUTCOME_STATUS: Record<string, string> = {
  success: "done",
  partial: "partial",
  failed: "failed",
};

/**
 * קידום סטטוס חד-כיווני: מחזיר את `next` רק אם הוא לא מדרג אחורה מ-`current`.
 * (בעבר: כל אתר היה מממש את ההשוואה בעצמו — ואחת מהן כבר סטתה)
 */
export function advanceStatus(current: string, next: string): string {
  return (STATUS_RANK[next] ?? 0) >= (STATUS_RANK[current] ?? 0) ? next : current;
}
