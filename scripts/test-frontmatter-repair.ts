// Round-10 regression test — the law of SKILL.md frontmatter (src/lib/skill-md.ts).
// Offline and self-contained: the real field-failure shape (draft 7f58878d — the LLM
// opened `---` and never closed it, permanently failing G5-skill-md) is embedded as a
// literal so the test no longer depends on a draft file that publish deletes.
import { repairSkillMdFrontmatter, hasFrontmatter } from "../src/lib/skill-md";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
};

// == Case 1: the real unterminated field shape (7f58878d, verbatim head) ==
const broken =
  "---\nname: PR Automation Orchestrator\ndescription: Comprehensive PR lifecycle management with intelligent issue triage and duplicate detection\n\n## Overview\nThis skill orchestrates the complete pull request workflow.\n\n## Core Capabilities\n- Automatically create pull requests\n- Triage incoming issues by urgency and topic\n- Detect duplicate issues before filing\n";
const r1 = repairSkillMdFrontmatter(broken, { name: "pr-automation-orchestrator", description: "Automates the PR lifecycle" });
t("real field case: detected as broken before", !hasFrontmatter(broken));
t("real field case: repaired by closing the block", r1.repaired && r1.how === "closed");
t("real field case: terminated after repair", hasFrontmatter(r1.md));
t("real field case: YAML head preserved inside the block", r1.md.startsWith("---\nname: PR Automation Orchestrator\n"));
t("real field case: body preserved after the block", r1.md.includes("## Overview"));

// == Case 2: no frontmatter at all — synthesized from sibling fields ==
const r2 = repairSkillMdFrontmatter("# My Skill\n\nSome body content\n", { name: "my-skill", description: "does things: well" });
t("no frontmatter: synthesized", r2.how === "synthesized" && hasFrontmatter(r2.md));
t("no frontmatter: body preserved", r2.md.includes("# My Skill"));
t("no frontmatter: YAML-unsafe description quoted", r2.md.includes('description: "does things: well"'));

// == Case 3: already valid — untouched ==
const valid = "---\nname: x\ndescription: y\n---\n\nbody";
const r3 = repairSkillMdFrontmatter(valid, { name: "n", description: "d" });
t("valid input: unchanged", r3.how === "ok" && !r3.repaired && r3.md === valid);

// == Case 4: CRLF + unterminated ==
const r4 = repairSkillMdFrontmatter("---\r\nname: x\r\ndescription: y\r\n\r\n## Body\r\ntext", { name: "n", description: "d" });
t("CRLF unterminated: closed and terminated", r4.how === "closed" && hasFrontmatter(r4.md));
t("CRLF unterminated: body kept", r4.md.includes("## Body"));

// == Case 5: opener followed by prose (not YAML) — synthesize, keep body ==
const r5 = repairSkillMdFrontmatter("---\nThis is prose right after the opener\n\n## Body\ntext", { name: "n", description: "d" });
t("prose after opener: synthesized, not closed", r5.how === "synthesized" && hasFrontmatter(r5.md));
t("prose after opener: body preserved", r5.md.includes("This is prose right after the opener"));

// == Case 6: YAML-hostile description (quotes + colons) ==
const r6 = repairSkillMdFrontmatter("body only", { name: "n", description: 'has "quotes" and: colons' });
t("hostile description: quoted safely", r6.md.split("\n")[2] === 'description: "has \'quotes\' and: colons"');

// == Case 7: name-collision repair target still ends with newline, never doubled ==
const r7 = repairSkillMdFrontmatter("---\nname: x\n\ndesc-less body\n", { name: "x", description: "d" });
t("single trailing newline", r7.md === r7.md.replace(/\n+$/, "\n"));

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
