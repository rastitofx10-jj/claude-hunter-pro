// ============================================================
// כורה DNA — חילוץ יכולות Claude חיות מריפואי אליטה
// סורק .claude/, CLAUDE.md, AGENTS.md ומוריד את התוכן האמיתי.
// זו השכבה שהופכת "ריפו מוצלח" לגנים ניידים להשתלה.
// ============================================================

import { ghFetch, ghFetchRaw, mapLimit } from "./github";

export interface MinedArtifact {
  path: string;
  kind: "skill" | "command" | "agent" | "claude-md" | "agents-md" | "mcp-config";
  name: string;
  description: string | null;
  content: string | null;
  rawUrl: string | null;
  size: number;
  truncated: boolean;
}

export interface DnaPackage {
  repo: string;
  defaultBranch: string;
  artifacts: MinedArtifact[];
  scannedAt: string;
  /** true אם עץ הקבצים נחתך (ריפו ענק) — הכרייה הייתה חלקית בשקט; עכשיו מדווח */
  treeTruncated: boolean;
}

interface GhTree {
  truncated?: boolean;
  tree: { path: string; type: string; size?: number }[];
}

const MAX_FILE_BYTES = 12_000; // חיתוך תוכן לקובץ — מספיק ל-AI, חוסך מכסה

/**
 * נתיבי בדיקות/פיקסטורות אינם קבצי-יכולת. ראיה מהשטח: Gen 6 כרה את
 * mcp_config_test.go (קובץ בדיקות Go) כ-"mcp-config" (גן #155) ואת
 * e2e/fixtures/.../SKILL.md (פיקסטורת e2e) כ-"skill" (גן #108) — שניהם נכנסו
 * לספרייה עם תיוג שקרי. מעכשיו: נתיבי test/spec/fixture נפסלים לכרייה.
 */
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec|specs|fixtures)(\/|$)|[._-]test\.[a-z]+$|\.spec\.[a-z]+$/i;

/** סיווג נתיב לסוג DNA */
function classify(path: string): MinedArtifact["kind"] | null {
  const p = path.toLowerCase();
  if (TEST_PATH_RE.test(p)) return null;
  if (p === "claude.md") return "claude-md";
  if (p === "agents.md") return "agents-md";
  // SKILL.md בדיוק (בכל עומק תיקייה) — בעבר p.includes("skill") סיווג בטעות
  // גם קבצים כמו docs/my-skill.md כסקיל; עכשיו רק שם-קובץ skill.md בדיוק.
  if (/(^|\/)skill\.md$/.test(p)) return "skill";
  if (p.includes(".claude/commands/") && /\.md$/.test(p)) return "command";
  if (p.includes(".claude/agents/") && /\.md$/.test(p)) return "agent";
  if (p.includes(".mcp.json") || p.includes("mcp_config")) return "mcp-config";
  return null;
}

/** חילוץ שם מפורמט frontmatter או מהנתיב */
function extractName(path: string, content: string | null, kind: MinedArtifact["kind"]): string {
  if (content) {
    // \r?\n — ריפואים שנכתבו ב-Windows עם CRLF לא נתפסו כלל כ-frontmatter
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const nameLine = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
      if (nameLine) return nameLine.replace(/^["']|["']$/g, "");
    }
    const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (h1 && h1.length <= 80) return h1;
  }
  if (kind === "skill") {
    const parts = path.split("/");
    return parts[parts.length - 2] ?? path;
  }
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|json)$/i, "");
}

/** חילוץ description מ-frontmatter */
function extractDescription(content: string | null): string | null {
  if (!content) return null;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const d = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (d) return d.slice(0, 300);
  }
  return null;
}

/**
 * כריית DNA מלאה מריפו: סריקת עץ → סינון קבצי יכולת → הורדת תכנים במקביל.
 * defaultBranch אופציונלי: כשמגיע מה-GraphQL של שלב הגילוי — חוסך קריאת
 * /repos נוספת לכל ריפו (בקציר של 6 ריפואים זה 6 קריאות פחות).
 */
export async function mineDna(
  owner: string,
  repo: string,
  token: string | null,
  opts?: { defaultBranch?: string | null }
): Promise<DnaPackage> {
  const full = `${owner}/${repo}`;
  let branch = opts?.defaultBranch || "";
  if (!branch) {
    const meta = await ghFetch<{ default_branch: string }>(`/repos/${full}`, token);
    branch = meta.default_branch || "main";
  }

  const tree = await ghFetch<GhTree>(
    `/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token
  );

  const candidates = (tree.tree ?? [])
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size ?? 0, kind: classify(t.path) }))
    .filter((t): t is { path: string; size: number; kind: NonNullable<ReturnType<typeof classify>> } => !!t.kind)
    // עדיפות: skills ופקודות קודם, ואז CLAUDE.md; הגבלת גודל סבירה
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .slice(0, 12);

  // מקביליות מרוסנת (6) — 12 הורדות בבת אחת × 2 ריפואים במקביל = 24 קריאות
  // פתוחות שיכולות להפיל מגבלת-משנה של GitHub. מנוע pool משותף מ-github.ts.
  const results = await mapLimit(
    candidates,
    6,
    async (c): Promise<MinedArtifact> => {
      let content: string | null = null;
      let rawUrl: string | null = null;
      let truncated = false;
      try {
        content = await ghFetchRaw(
          `/repos/${full}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
          token
        );
        rawUrl = `https://github.com/${full}/blob/${branch}/${c.path.split("/").map(encodeURIComponent).join("/")}`; // קידוד נתיב — רווחים/#/? בשמות קבצים שוברים קישור גולמי
      } catch {
        content = null;
      }
      if (content && content.length > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES) + "\n\n… [נחתך לכרייה]";
        truncated = true;
      }
      return {
        path: c.path,
        kind: c.kind,
        name: extractName(c.path, content, c.kind),
        description: extractDescription(content),
        content,
        rawUrl,
        size: c.size,
        truncated,
      };
    }
  );

  const artifacts = results;
  // (mapLimit זורק רק אם קריאה בודדת זרקה — אבל ה-catch הפנימי מבטיח שהורדה
  // שנכשלה מחזירה content=null ולא מפילה את כל הכרייה)

  return { repo: full, defaultBranch: branch, artifacts, scannedAt: new Date().toISOString(), treeTruncated: tree.truncated === true };
}

function rank(kind: MinedArtifact["kind"]): number {
  switch (kind) {
    case "skill":
      return 0;
    case "command":
      return 1;
    case "agent":
      return 2;
    case "claude-md":
      return 3;
    case "agents-md":
      return 4;
    case "mcp-config":
      return 5;
  }
}
