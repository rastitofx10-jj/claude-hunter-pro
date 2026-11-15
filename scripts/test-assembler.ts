// Pure tests: gene decoder, plugin assembler (license / executable gates), zip writer.
//   bun scripts/test-assembler.ts      (or: npx tsx scripts/test-assembler.ts)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGene, parseFrontmatter, splitTools, type GeneInput } from "../src/lib/gene-decoder";
import { assemblePlugin, setFrontmatterName, slugify } from "../src/lib/gene-assembler";
import { crc32, zipStore } from "../src/lib/zip-store";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} | ${name}`); };

// ---------- decoder ----------
const fm = parseFrontmatter(`---\nname: pdf-tools\ndescription: "Fill and merge PDFs: forms, merges"\nallowed-tools: Read, Grep, Bash(git diff:*)\nmodels:\n  - claude-opus-5-5\n  - claude-sonnet-5-5\ninline: [a, "b c"]\n---\n# Body\n`);
check("frontmatter: quoted scalar with colon", fm.data.description === "Fill and merge PDFs: forms, merges");
check("frontmatter: dash list", Array.isArray(fm.data.models) && (fm.data.models as string[]).length === 2);
check("frontmatter: inline array", Array.isArray(fm.data.inline) && (fm.data.inline as string[])[1] === "b c");
check("frontmatter: body separated", fm.body.startsWith("# Body"));
check("frontmatter: CRLF + BOM tolerated", parseFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nbody").data.name === "x");
check("frontmatter: unclosed block is not valid", parseFrontmatter("---\nname: x\nno closer").ok === false);
check("splitTools keeps commas inside parentheses", JSON.stringify(splitTools("Read, Bash(git log, git diff:*), Grep")) === JSON.stringify(["Read", "Bash(git log, git diff:*)", "Grep"]));

const skillMd = `---\nname: pdf-tools\ndescription: Fill and merge PDF forms\nallowed-tools: Read, Bash\nmodel: claude-opus-5-5\n---\n\n# PDF tools\n\n## Forms\nSee references/forms.md and run scripts/fill.py for filling. ${"Detailed guidance. ".repeat(20)}\n`;
const d1 = decodeGene({ sourceRepo: "acme/skills", path: "skills/pdf/SKILL.md", kind: "skill", name: "pdf", content: skillMd, license: "MIT" });
check("decode skill: name from frontmatter", d1.name === "pdf-tools");
check("decode skill: allowed tools", d1.allowedTools.join("|") === "Read|Bash");
check("decode skill: referenced files", d1.referencedFiles.includes("references/forms.md") && d1.referencedFiles.includes("scripts/fill.py"));
check("decode skill: premium model pin", d1.modelPins.includes("claude-opus-5-5"));
check("decode skill: headings", d1.headings.includes("PDF tools") && d1.headings.includes("Forms"));
check("decode skill: no issues", d1.issues.length === 0);
check("decode skill without frontmatter flagged", decodeGene({ sourceRepo: "a/b", path: "SKILL.md", kind: "skill", name: "x", content: "# just text" }).issues.some((i) => i.includes("frontmatter")));

const mcp = JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "@x/files"] }, web: { url: "https://example.com/mcp" } } });
const dm = decodeGene({ sourceRepo: "a/b", path: ".mcp.json", kind: "mcp-config", name: "mcp", content: mcp });
check("decode mcp: servers + commands", dm.mcpServers.join(",") === "files,web" && dm.mcpCommands[0] === "files: npx -y @x/files");
const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }] }, permissions: { allow: ["Bash(*)"] } });
const dh = decodeGene({ sourceRepo: "a/b", path: "hooks/hooks.json", kind: "hook-config", name: "h", content: hooks });
check("decode hooks: events + commands", dh.hookEvents[0] === "PreToolUse" && dh.hookCommands[0] === "PreToolUse: ./check.sh");
check("decode: invalid JSON reported", decodeGene({ sourceRepo: "a/b", path: ".mcp.json", kind: "mcp-config", name: "m", content: "{nope" }).issues.length === 1);
check("decode: empty content reported", decodeGene({ sourceRepo: "a/b", path: "x.md", kind: "command", name: "x", content: "  " }).issues[0] === "empty content");

// ---------- assembler ----------
const G = (o: Partial<GeneInput> & { path: string; kind: string }): GeneInput => ({ sourceRepo: "acme/skills", name: o.path, content: "x", license: "MIT", ...o });
const refMd = `# Forms\n\n## Fill\n${"Reference text. ".repeat(20)}`;
const cmdMd = `---\ndescription: Run the checks\n---\nRun the test suite and report. ${"x".repeat(60)}`;
const agentMd = `---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\n---\nYou review diffs. ${"x".repeat(60)}`;
const base: GeneInput[] = [
  G({ path: "skills/pdf/SKILL.md", kind: "skill", name: "pdf-tools", content: skillMd }),
  G({ path: "skills/pdf/references/forms.md", kind: "skill-ref", name: "pdf/forms", content: refMd }),
  G({ path: ".claude/commands/check.md", kind: "command", name: "check", content: cmdMd }),
  G({ path: ".claude/agents/reviewer.md", kind: "agent", name: "reviewer", content: agentMd }),
];
let r = assemblePlugin(base, { name: "demo-bundle", description: "demo", author: "me" });
check("assemble: ok with MIT genes", r.ok && r.report.included.length === 4);
check("assemble: layout", ["skills/pdf-tools/SKILL.md", "skills/pdf-tools/references/forms.md", "commands/check.md", "agents/reviewer.md", ".claude-plugin/plugin.json", "README.md", "NOTICE.md"].every((p) => p in r.files));
check("assemble: plugin.json valid", JSON.parse(r.files[".claude-plugin/plugin.json"]).name === "demo-bundle");
check("assemble: NOTICE credits source + license", r.files["NOTICE.md"].includes("acme/skills") && r.files["NOTICE.md"].includes("MIT"));
check("assemble: tool requests aggregated", r.report.toolRequests.includes("Read") && r.report.toolRequests.includes("Bash"));
check("assemble: unrestricted Bash warned", r.report.warnings.some((w) => w.includes("unrestricted Bash")));
check("assemble: deterministic key order", JSON.stringify(Object.keys(r.files)) === JSON.stringify([...Object.keys(r.files)].sort()));

r = assemblePlugin([...base, G({ path: "skills/gpl/SKILL.md", kind: "skill", name: "gpl-skill", content: skillMd.replace("pdf-tools", "gpl-skill") + "z", license: "GPL-3.0" })], { name: "demo-bundle" });
check("license: GPL excluded by default", r.report.excluded.some((e) => e.gene.includes("gpl") && e.reason.includes("not on the permissive list")));
r = assemblePlugin([G({ path: "skills/u/SKILL.md", kind: "skill", name: "u", content: skillMd.replace("pdf-tools", "u"), license: null })], { name: "demo-bundle" });
check("license: unknown excluded → nothing assembled", !r.ok && r.report.excluded[0].reason === "license unknown");
r = assemblePlugin([G({ path: "skills/u/SKILL.md", kind: "skill", name: "u", content: skillMd.replace("pdf-tools", "u"), license: null })], { name: "demo-bundle", acceptLicenseRisk: true });
check("license: acceptLicenseRisk includes and NOTICE warns loudly", r.ok && r.files["NOTICE.md"].includes("WARNING"));
r = assemblePlugin([G({ path: "a/SKILL.md", kind: "skill", name: "a", content: skillMd, license: "self" })], { name: "demo-bundle" });
check("license: self-born genes are allowed", r.ok);

r = assemblePlugin([G({ path: "a/SKILL.md", kind: "skill", name: "a", content: skillMd }), G({ path: "b/SKILL.md", kind: "skill", name: "b", content: skillMd })], { name: "demo-bundle" });
check("dedupe: identical content excluded", r.report.included.length === 1 && r.report.excluded[0].reason.startsWith("duplicate of"));

r = assemblePlugin([G({ path: "a/SKILL.md", kind: "skill", name: "a", content: skillMd }), G({ path: "b/SKILL.md", kind: "skill", name: "b", content: skillMd + "\nmore" })], { name: "demo-bundle" });
check("collision: second skill renamed -2 and reported", "skills/pdf-tools/SKILL.md" in r.files && "skills/pdf-tools-2/SKILL.md" in r.files && r.report.conflicts.length === 1);
check("collision: frontmatter name rewritten to the directory slug", r.files["skills/pdf-tools-2/SKILL.md"].includes("name: pdf-tools-2"));

r = assemblePlugin([G({ path: "a/SKILL.md", kind: "skill", name: "a", content: "---\ndescription: \n---\nbody" + "x".repeat(250) })], { name: "demo-bundle" });
check("skill without description excluded", !r.ok && r.report.excluded[0].reason.includes("description"));
r = assemblePlugin([G({ path: "a/SKILL.md", kind: "skill", name: "Fix Bugs", description: "Fixes bugs fast", content: "Just a body without frontmatter. " + "x".repeat(250) })], { name: "demo-bundle" });
check("no frontmatter + description → repaired, name = slug", r.ok && r.files["skills/fix-bugs/SKILL.md"].startsWith("---\nname: fix-bugs"));
r = assemblePlugin([G({ path: "skills/pdf/references/forms.md", kind: "skill-ref", name: "pdf/forms", content: refMd })], { name: "demo-bundle" });
check("orphan reference excluded", !r.ok && r.report.excluded[0].reason.includes("orphan"));

const hookGene = G({ path: "hooks/hooks.json", kind: "hook-config", name: "h", content: hooks });
const mcpGene = G({ path: ".mcp.json", kind: "mcp-config", name: "m", content: mcp });
r = assemblePlugin([...base, hookGene, mcpGene], { name: "demo-bundle" });
check("executables: hooks + MCP excluded by default", !("hooks/hooks.json" in r.files) && !(".mcp.json" in r.files) && r.report.excluded.filter((e) => e.reason.includes("allowExecutables")).length === 2);
r = assemblePlugin([...base, hookGene, mcpGene], { name: "demo-bundle", allowExecutables: true });
check("executables: included when allowed", "hooks/hooks.json" in r.files && ".mcp.json" in r.files);
check("executables: commands listed for review", r.report.executables.hooks[0] === "PreToolUse: ./check.sh" && r.report.executables.mcp.includes("files: npx -y @x/files"));
check("executables: permissions block never imported", !r.files["hooks/hooks.json"].includes("permissions") && r.report.warnings.some((w) => w.includes("NOT imported")));
check("executables: README carries a review section", r.files["README.md"].includes("Review before installing"));
const mcp2 = JSON.stringify({ mcpServers: { files: { command: "python", args: ["evil.py"] } } });
r = assemblePlugin([mcpGene, G({ sourceRepo: "other/repo", path: ".mcp.json", kind: "mcp-config", name: "m2", content: mcp2 })], { name: "demo-bundle", allowExecutables: true });
check("MCP conflict keeps the first definition and reports it", JSON.parse(r.files[".mcp.json"]).mcpServers.files.command === "npx" && r.report.conflicts.length === 1);

r = assemblePlugin(base, { name: "Bad Name!" });
check("invalid plugin name rejected", !r.ok);
r = assemblePlugin([G({ path: "CLAUDE.md", kind: "claude-md", name: "c", content: "# c" + "x".repeat(250) })], { name: "demo-bundle" });
check("repo-level contract files are not components", !r.ok && r.report.excluded[0].reason.includes("contract"));
check("slugify", slugify("Fix Bugs & Ship!") === "fix-bugs-ship" && slugify("???", "skill") === "skill");
check("setFrontmatterName adds a missing name line", setFrontmatterName("---\ndescription: d\n---\nb", "x").includes("name: x"));

// ---------- zip ----------
r = assemblePlugin(base, { name: "demo-bundle" });
const zip = zipStore(r.files);
const eocd = zip.readUInt32LE(zip.length - 22);
check("zip: end-of-central-directory signature", eocd === 0x06054b50);
check("zip: entry count", zip.readUInt16LE(zip.length - 22 + 10) === Object.keys(r.files).length);
check("zip: crc32 known vector", crc32(Buffer.from("123456789")) === 0xcbf43926);
check("zip: unsafe paths refused", (() => { try { zipStore({ "../x": "y" }); return false; } catch { return true; } })());
try {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const f = join(dir, "b.zip");
  writeFileSync(f, zip);
  const out = execFileSync("unzip", ["-t", f], { encoding: "utf8" });
  check("zip: `unzip -t` verifies every entry", /No errors detected/.test(out));
} catch (e) {
  console.log(`SKIP | unzip not available: ${(e as Error).message.split("\n")[0]}`);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
