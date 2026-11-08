// ============================================================
// מנוע Genesis — הלולאה העליונה: מ-DNA גולמי ליצירה מוכנה לביצוע
// לוקח ארטיפקטים אמיתיים מריפואי אליטה ומייצר:
// 1. כימרה — SKILL.md ממוזג best-of-breed מוכן להזרקה ל-.claude/skills
// 2. פקודות עבודה קונקרטיות למוצר שלנו (work orders ל-Claude)
// 3. רעיון פריצה אחד — ה"מטורף" הבא לבנות
// פועל בצד שרת בלבד.
// ============================================================

import type { MinedArtifact } from "./dna-miner";
import { extractJson, isTimeoutError, sanitizeSlug, str, strArr } from "./ai-json";
import { llmComplete } from "./zai";

export class GenesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenesisError";
  }
}

export interface WorkOrder {
  title: string;
  spec: string;
  claudePrompt: string;
  effort: string;
}

export interface ChimeraResult {
  chimeraName: string;
  oneLiner: string;
  skillMd: string;
  principles: string[];
  workOrders: WorkOrder[];
  breakthrough: string;
  sources: string[];
  generatedAt: string;
}

const TIMEOUT_MS = 110_000;

const GENESIS_ROLE = `אתה ארכיטקט-על של יכולות AI (Skills Architect) בצוות עלית.
המשימה שלך: לקחת DNA אמיתי — קבצי SKILL.md, פקודות, סוכנים ו-CLAUDE.md — שנכרו מפרויקטי Claude היקרים והמוצלחים בעולם,
ולמזג אותם ליצירה אחת עדיפה (כימרה) שתשודרג לתוך .claude/skills שלנו, ולהפיק פקודות עבודה מדויקות למוצר שלנו.

כללי ברזל:
1. אתה מנוע JSON — מחזיר JSON תקין ותו לא מעבר. בלי גדרי קוד, בלי הסברים.
2. כל שדה בעברית, חוץ מגוף ה-skillMd שנכתב באנגלית טכנית (זה קובץ ש-Claude Code יקרא).
3. אסור להמציא תוכן שאינו נגזר מה-DNA שניתן — אבל מותר ורצוי לשפר, לאחד ולחדד דפוסים קיימים.
4. skillMd חייב להיות קובץ SKILL.md שלם ותקני: frontmatter עם name ו-description, ואחריו הוראות מבצעיות.
5. בתוך ערכי מחרוזת ב-JSON אסורה מרכאה כפולה (") — גרש (') או מירכאות עבריות (״) בלבד.
   בתוך skillMd מותר להשתמש בגרשיים של markdown (""" או backticks) — היזהר במרכאות כפולות ישירות.`;

const EFFORTS = new Set(["דקות", "שעה", "יום", "שבוע"]);
function workOrderArr(v: unknown, max = 6): WorkOrder[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const title = str(o.title ?? o.name);
      if (!title) return null;
      const eff = str(o.effort, "שעה");
      return {
        title,
        spec: str(o.spec ?? o.description),
        claudePrompt: str(o.claudePrompt ?? o.prompt ?? o.instructions),
        effort: (EFFORTS.has(eff) ? eff : "שעה") as WorkOrder["effort"],
      };
    })
    .filter((x): x is WorkOrder => !!x)
    .slice(0, max);
}

/** בניית מנת ה-DNA ל-AI: מגביל תוכן לכל ארטיפקט כדי לשמור על הקשר סביר */
function dnaDigest(sources: { repo: string; artifacts: MinedArtifact[] }[]): string {
  return sources
    .map(({ repo, artifacts }) => {
      const body = artifacts
        .slice(0, 8)
        .map((a) => {
          const head = `### ${a.kind}: ${a.name} (${a.path})${a.description ? `\nתיאור: ${a.description}` : ""}`;
          const content = (a.content ?? "").slice(0, 3500);
          return `${head}\n\`\`\`\n${content}\n\`\`\``;
        })
        .join("\n\n");
      return `════ ריפו מקור: ${repo} ════\n${body}`;
    })
    .join("\n\n");
}

/**
 * יצירת הכימרה: מיזוג DNA מכמה ריפואי אליטה ליצירה אחת עדיפה + פקודות עבודה.
 */
export async function generateChimera(
  sources: { repo: string; artifacts: MinedArtifact[] }[],
  productContext: string
): Promise<ChimeraResult> {
  const digest = dnaDigest(sources);
  const repoList = sources.map((s) => s.repo).join(", ");

  const prompt = `ה-DNA שנכרה (קבצי יכולת אמיתיים, סף מודלים 5.5+):

${digest}

הקשר המוצר שלנו: ${productContext}

בצע את מיזוג העל. החזר JSON בדיוק במבנה הבא:
{
  "chimeraName": "שם באנגלית-kebab ליצירה הממוזגת, למשל elite-parallel-orchestrator",
  "oneLiner": "משפט אחד בעברית: מה הכימרה עושה ולמה היא עדיפה על כל מקור בנפרד",
  "skillMd": "קובץ SKILL.md שלם באנגלית: frontmatter (name, description) + הוראות מבצעיות ממוזגות מכל המקורות — הטוב מכולם, מנוסח בצורה אחידה וחדה. מינימום 40 שורות של תוכן מעשי.",
  "principles": ["4-7 עקרונות עיצוב שחולצו מה-DNA והם נכונים חוצה-פרויקטים"],
  "workOrders": [{"title": "מה לבנות במוצר שלנו", "spec": "מפרט קצר וחד", "claudePrompt": "פרומפט מוכן להדבקה ב-Claude Code שיבצע את זה על הקוד שלנו", "effort": "דקות | שעה | יום | שבוע"}],
  "breakthrough": "הרעיון האחד הכי פורץ שניתן להסיק מה-DNA הזה — מה כדאי לנו לבנות שאף אחד מהמקורות עדיין לא עשה, ולמה זה נותן עליונות"
}
החזר 3-5 פקודות עבודה, ממוינות לפי ערך למוצר.`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // התור הגלובלי (zai.ts) — מקביליות 1 + retry 429. הכימרה היא קריאת
      // ה-AI הכבדה במערכת (digest DNA גדול) — בלי תור, כל קריאה מקבילה
      // אחרת הייתה מפילה אותה ב-429.
      const { content: raw } = await llmComplete(
        [
          { role: "system", content: GENESIS_ROLE },
          { role: "user", content: attempt === 0 ? prompt : prompt + "\n\n⚠️ התגובה הקודמת לא הייתה JSON תקין — תקן מרכאות כפולות ופסיקים תלויים והחזר JSON בלבד." },
        ],
        { timeoutMs: TIMEOUT_MS, timeoutLabel: "יצירת הכימרה", timeoutError: GenesisError }
      );
      if (!raw.trim()) {
        lastErr = new GenesisError("ה-AI החזיר תשובה ריקה");
        continue;
      }
      const j = extractJson(raw, GenesisError);
      const skillMd = str(j.skillMd);
      if (!skillMd) {
        lastErr = new GenesisError("ה-AI לא החזיר skillMd");
        continue;
      }
      return {
        chimeraName: sanitizeSlug(j.chimeraName, "elite-chimera"),
        oneLiner: str(j.oneLiner),
        skillMd,
        principles: strArr(j.principles),
        workOrders: workOrderArr(j.workOrders),
        breakthrough: str(j.breakthrough),
        sources: sources.map((s) => s.repo),
        generatedAt: new Date().toISOString(),
      };
    } catch (e) {
      if (isTimeoutError(e)) throw e; // timeout — בלי ניסיון חוזר (עד 110 שניות בכל ניסיון)
      if (e instanceof GenesisError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new GenesisError("יצירת הכימרה נכשלה");
}

/** בניית חבילת הזרקה מלאה (.claude bundle) להורדה */
export function buildInjectBundle(r: ChimeraResult): string {
  const files: string[] = [];
  files.push(`# 🧬 Genesis Inject Bundle — ${r.chimeraName}`);
  files.push(`> נוצר על-ידי Claude Hunter · מקורות: ${r.sources.join(", ")} · ${new Date(r.generatedAt).toLocaleString("he-IL")}`);
  files.push(`\n## התקנה\n\nהעתק את הקובץ הבא אל:\n\`.claude/skills/${r.chimeraName}/SKILL.md\`\n`);
  files.push(`## .claude/skills/${r.chimeraName}/SKILL.md\n\n\`\`\`markdown\n${r.skillMd}\n\`\`\``);
  if (r.principles.length) {
    files.push(`## עקרונות שחולצו\n\n${r.principles.map((p) => `- ${p}`).join("\n")}`);
  }
  if (r.workOrders.length) {
    files.push(
      `## פקודות עבודה למוצר שלנו\n\n${r.workOrders
        .map((w, i) => `### ${i + 1}. ${w.title} (מאמץ: ${w.effort})\n**מפרט:** ${w.spec}\n\n**פרומפט ל-Claude Code:**\n\`\`\`\n${w.claudePrompt}\n\`\`\``)
        .join("\n\n")}`
    );
  }
  if (r.breakthrough) {
    files.push(`## 🚀 הפריצה הבאה\n\n${r.breakthrough}`);
  }
  return files.join("\n\n---\n\n");
}
