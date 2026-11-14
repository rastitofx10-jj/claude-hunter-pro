// ============================================================
// The law of SKILL.md frontmatter — a single source.
//
// Field diagnosis (draft 7f58878d): the LLM opened with `---` but never
// closed the block — `name:` / `description:` lines flowed straight into
// `## Overview`. Every validator in the system only checked the OPENER
// (`/^---/`) and never the closer, so the broken shape sailed through
// two producers (compileSkillMd, normalizeBornSkillMd) and then permanently
// failed G5-skill-md at draft validation — with no retry path, the chimera
// was unpublishable forever. One repair function, one law, every caller.
// ============================================================

/** Valid frontmatter: opened with `---`, closed with a second `---`. */
export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** True only when the block is properly TERMINATED (opener alone proves nothing). */
export function hasFrontmatter(md: string): boolean {
  return FRONTMATTER_RE.test((md ?? "").replace(/^\r?\n+/, ""));
}

/** YAML-safe scalar — quotes values that contain YAML-breaking characters. */
function yamlScalar(v: string): string {
  const s = (v ?? "").replace(/["\\]/g, "'").replace(/\r?\n/g, " ").trim();
  if (!s) return '""';
  return /[:#\-]/.test(s) ? `"${s}"` : s;
}

/** A YAML-ish line: `key: value` / `key:` / `- item` */
const YAML_LINE_RE = /^(?:[A-Za-z_][\w.-]*\s*:\s*.*|- .+|\.\.\.|---)\s*$/;

export type FrontmatterRepair = {
  md: string;
  repaired: boolean;
  /** "ok" | "closed" | "synthesized" — the diagnosis, for field logs */
  how: "ok" | "closed" | "synthesized";
};

/**
 * Deterministic frontmatter repair — no AI content is invented:
 * - "closed": the opener exists and the head looks like YAML → close it.
 * - "synthesized": no usable opener → build the block from sibling fields
 *   (name + description the SAME response already guarantees).
 */
export function repairSkillMdFrontmatter(
  raw: string,
  fallback: { name: string; description: string },
): FrontmatterRepair {
  const src = (raw ?? "").replace(/^\r?\n+/, "").replace(/\s+$/, "\n");
  if (FRONTMATTER_RE.test(src)) return { md: src, repaired: false, how: "ok" };

  const lines = src.split(/\r?\n/);

  // ---- Case A: an opener exists (`---`) but was never closed ----
  if (lines[0]?.trim() === "---") {
    // The head = consecutive YAML-looking lines after the opener;
    // it ends at a blank line, a markdown heading, or a second `---`.
    let k = 1;
    while (k < lines.length) {
      const l = lines[k].trim();
      if (l === "" || l.startsWith("#") || l === "---") break;
      if (!YAML_LINE_RE.test(l)) break; // prose right after the opener → not YAML
      k++;
    }
    const head = lines.slice(1, k);
    const body = lines.slice(k).join("\n");
    if (head.length > 0) {
      const block = ["---", ...head, "---"].join("\n");
      const md = body.trim() ? `${block}\n\n${body.trim()}\n` : `${block}\n`;
      return { md, repaired: true, how: "closed" };
    }
    // Opener but NO YAML head — drop the dangling `---` and synthesize.
    const rest = lines.slice(1).join("\n").replace(/^\r?\n+/, "");
    const block = ["---", `name: ${yamlScalar(fallback.name)}`, `description: ${yamlScalar(fallback.description)}`, "---"].join("\n");
    const md = rest.trim() ? `${block}\n\n${rest.trim()}\n` : `${block}\n`;
    return { md, repaired: true, how: "synthesized" };
  }

  // ---- Case B: no frontmatter at all — synthesize from the sibling fields ----
  const block = ["---", `name: ${yamlScalar(fallback.name)}`, `description: ${yamlScalar(fallback.description)}`, "---"].join("\n");
  const md = src.trim() ? `${block}\n\n${src.trim()}\n` : `${block}\n`;
  return { md, repaired: true, how: "synthesized" };
}
