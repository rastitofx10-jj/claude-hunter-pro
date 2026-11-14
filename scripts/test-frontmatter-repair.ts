import { repairSkillMdFrontmatter, hasFrontmatter } from "../src/lib/skill-md";
import { readFileSync } from "node:fs";

// The real failing shape from draft 7f58878d: opener without closer
const real = readFileSync("./reports/state/chimera-drafts/7f58878d.json", "utf8");
const d = JSON.parse(real);
const broken = d.skillMd as string;

console.log("== Case 1: real unterminated draft ==");
console.log("before hasFrontmatter:", hasFrontmatter(broken));
const r1 = repairSkillMdFrontmatter(broken, { name: d.chimeraName, description: d.oneLiner });
console.log("repaired:", r1.repaired, "| how:", r1.how);
console.log("after hasFrontmatter:", hasFrontmatter(r1.md));
console.log("HEAD:", JSON.stringify(r1.md.slice(0, 150)));

console.log("\n== Case 2: no frontmatter at all ==");
const noFront = "# My Skill\n\nSome body content\n";
const r2 = repairSkillMdFrontmatter(noFront, { name: "my-skill", description: "does things: well" });
console.log("how:", r2.how, "| hasFront:", hasFrontmatter(r2.md));
console.log(JSON.stringify(r2.md.slice(0, 120)));

console.log("\n== Case 3: already valid ==");
const valid = "---\nname: x\ndescription: y\n---\n\nbody";
const r3 = repairSkillMdFrontmatter(valid, { name: "n", description: "d" });
console.log("how:", r3.how, "| repaired:", r3.repaired, "| unchanged:", r3.md === valid);

console.log("\n== Case 4: CRLF + unterminated ==");
const crlf = "---\r\nname: x\r\ndescription: y\r\n\r\n## Body\r\ntext";
const r4 = repairSkillMdFrontmatter(crlf, { name: "n", description: "d" });
console.log("how:", r4.how, "| hasFront:", hasFrontmatter(r4.md));
console.log(JSON.stringify(r4.md.slice(0, 100)));

console.log("\n== Case 5: opener followed by prose (not YAML) ==");
const prose = "---\nThis is prose right after the opener\n\n## Body\ntext";
const r5 = repairSkillMdFrontmatter(prose, { name: "n", description: "d" });
console.log("how:", r5.how, "| hasFront:", hasFrontmatter(r5.md));
console.log("body preserved:", r5.md.includes("This is prose right after the opener"));

console.log("\n== Case 6: YAML with colons/quotes in description ==");
const r6 = repairSkillMdFrontmatter("body only", { name: "n", description: 'has "quotes" and: colons' });
console.log("how:", r6.how);
console.log(JSON.stringify(r6.md.split("\n").slice(0, 4)));
