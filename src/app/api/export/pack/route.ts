import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * חבילת ייצוא מלאה — "קודקס ה-DNA":
 * כל הגנים מהאליטה + הגנים שנולדו מהשדה + הכימרות, בקובץ Markdown אחד
 * מוכן להזרקה לכל פרויקט (.claude/skills + CLAUDE.md addendum).
 */
export async function GET() {
  try {
    // take מפורש — בעבר: findMany בלי גבול עם content מלא; הקציר האוטומטי מגדיל
    // את הספרייה כל הזמן והייצוא תפח בלי מגבלה (בדיוק האנטי-דפוסן ש-mission/route.ts
    // כבר תיקן בסבב קודם).
    const EXPORT_TAKE = 600;
    const [artifacts, chimeras, fieldCount] = await Promise.all([
      db.dnaArtifact.findMany({ orderBy: [{ sourceRepo: "asc" }, { path: "asc" }], take: EXPORT_TAKE }),
      db.chimera.findMany({ orderBy: { id: "desc" }, take: 10 }),
      db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:" } } }),
    ]);

    if (artifacts.length === 0) {
      return NextResponse.json({ error: "הספרייה ריקה — אין מה לייצא. הרץ קציר או כרייה קודם." }, { status: 400 });
    }

    const L: string[] = [];
    L.push(`# 🧬 Claude Hunter — DNA Codex`);
    L.push(
      `> נוצר אוטומטית · ${new Date().toLocaleString("he-IL")} · ${artifacts.length} גנים מ-${new Set(artifacts.map((a) => a.sourceRepo)).size} מקורות (${fieldCount} נולדו מהשדה) · סף מודלים 5.5+`
    );
    L.push(
      `\n## התקנה לכל פרויקט\n\n1. צור תיקיית \`skills/\` בשורש הפרויקט (או \`.claude/skills/\` ל-Claude Code).\n2. העתק כל קובץ לפי הנתיב הרשום בכותרת שלו.\n3. הערכת CLAUDE.md בסוף הקובץ — שפכו לתוך ה-CLAUDE.md שלכם.`
    );

    const bySource = new Map<string, typeof artifacts>();
    for (const a of artifacts) {
      const arr = bySource.get(a.sourceRepo) ?? [];
      arr.push(a);
      bySource.set(a.sourceRepo, arr);
    }

    let fileNo = 0;
    for (const [source, items] of bySource) {
      const isField = source.startsWith("field:");
      L.push(`\n---\n\n# ${isField ? "🧪 מהשדה (ניסיון מצטבר)" : "📦 מקור"}: ${source}`);
      for (const a of items) {
        fileNo++;
        L.push(`\n## [${fileNo}] ${a.kind} · ${a.path}${a.description ? `\n> ${a.description}` : ""}`);
        L.push(`\`\`\`markdown\n${a.content ?? "(אין תוכן)"}\n\`\`\``);
      }
    }

    if (chimeras.length) {
      L.push(`\n---\n\n# ⚗️ כימרות ממוזגות (${chimeras.length})`);
      for (const c of chimeras) {
        L.push(`\n## ${c.name}\n> מקורות: ${c.sources.split(",").join(" · ")}`);
        L.push(`\`\`\`markdown\n${c.skillMd}\n\`\`\``);
      }
    }

    L.push(
      `\n---\n\n# 📘 CLAUDE.md Addendum\n\n> הוסף את זה ל-CLAUDE.md של הפרויקט שלך כדי שהסוכן ידע על הסקילים:\n\n\`\`\`markdown\n## Available Skills (from Claude Hunter DNA Codex)\n\nThe following skills are available in skills/ — read the relevant SKILL.md before attempting a matching task:\n${artifacts
        .filter((a) => a.kind === "skill" || a.kind === "command")
        .map((a) => `- ${a.path}: ${a.description ?? a.name}`)
        .join("\n")}\n\`\`\``
    );

    const content = L.join("\n");
    return NextResponse.json({
      filename: `claude-hunter-dna-codex-${Date.now()}.md`,
      stats: { artifacts: artifacts.length, sources: bySource.size, chimeras: chimeras.length, bytes: content.length },
      content,
    });
  } catch (e) {
    console.error("export/pack failed", e);
    return NextResponse.json({ error: "ייצוא הקודקס נכשל" }, { status: 500 });
  }
}
