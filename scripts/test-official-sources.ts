// Pure tests: folder-mode classification, skill-folder detection, official-repo ranking, quality gate for the new kinds.
//   bun scripts/test-official-sources.ts    (or: npx tsx scripts/test-official-sources.ts)
import { classifyPath, skillDirOf } from "../src/lib/dna-miner";
import { scoreGene } from "../src/lib/quality-gate";
import { scoreOfficialRepo } from "../src/lib/anthropic-sources";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} | ${name}`); };

// skill dirs
check("skillDirOf nested", skillDirOf("skills/pdf/SKILL.md") === "skills/pdf");
check("skillDirOf root", skillDirOf("SKILL.md") === "");
check("skillDirOf rejects myskill.md", skillDirOf("docs/myskill.md") === null);
check("skillDirOf case-insensitive", skillDirOf("a/b/skill.md") === "a/b");

// classic mode is unchanged
check("classic: plugin.json NOT mined", classifyPath(".claude-plugin/plugin.json") === null);
check("classic: hooks.json NOT mined", classifyPath("hooks/hooks.json") === null);
check("classic: references NOT mined", classifyPath("skills/pdf/references/forms.md") === null);
check("classic: SKILL.md still a skill", classifyPath("skills/pdf/SKILL.md") === "skill");
check("classic: CLAUDE.md still claude-md", classifyPath("CLAUDE.md") === "claude-md");

// folder mode
const folder = { skillDirs: new Set(["skills/pdf", ""]) };
check("folder: plugin.json", classifyPath(".claude-plugin/plugin.json", folder) === "plugin-manifest");
check("folder: marketplace.json (nested plugin)", classifyPath("plugins/x/.claude-plugin/marketplace.json", folder) === "plugin-manifest");
check("folder: hooks/hooks.json", classifyPath("plugins/x/hooks/hooks.json", folder) === "hook-config");
check("folder: .claude/settings.json", classifyPath(".claude/settings.json", folder) === "hook-config");
check("folder: settings.local.json is NOT mined (personal)", classifyPath(".claude/settings.local.json", folder) === null);
check("folder: references next to a SKILL.md", classifyPath("skills/pdf/references/forms.md", folder) === "skill-ref");
check("folder: root skill references", classifyPath("references/api.md", folder) === "skill-ref");
check("folder: references of a non-skill dir are ignored", classifyPath("docs/references/api.md", folder) === null);
check("folder: test fixtures stay rejected", classifyPath("tests/fixtures/.claude-plugin/plugin.json", folder) === null);

// quality gate
const body = (n: number) => "x".repeat(n);
const manifest = JSON.stringify({ name: "demo-plugin", description: "A demo plugin for tests", version: "1.0.0", author: { name: "Acme" } });
check("gate: valid plugin manifest passes", scoreGene({ path: ".claude-plugin/plugin.json", kind: "plugin-manifest", name: "demo-plugin", description: "A demo plugin for tests", content: manifest, rawUrl: null, size: manifest.length, truncated: false }).verdict === "pass");
check("gate: invalid JSON hook config hard-rejected", scoreGene({ path: "hooks/hooks.json", kind: "hook-config", name: "hooks", description: null, content: "{ nope " + body(300), rawUrl: null, size: 300, truncated: false }).verdict === "reject");
const ref = "# Forms\n\n## Fill a form\n\n- step one\n- step two\n\n```py\nprint('x')\n```\n\n" + "Detailed guidance. ".repeat(40);
check("gate: skill reference doc with headings passes", scoreGene({ path: "skills/pdf/references/forms.md", kind: "skill-ref", name: "pdf/forms", description: null, content: ref, rawUrl: null, size: ref.length, truncated: false }).verdict === "pass");

// official ranking
const mk = (o: Partial<Parameters<typeof scoreOfficialRepo>[0]> & { name: string }) => ({
  full_name: `anthropics/${o.name}`, name: o.name, description: null, archived: false, disabled: false, fork: false,
  size: 100, stargazers_count: 100, pushed_at: new Date().toISOString(), default_branch: "main", topics: [], license: null, ...o,
});
const now = Date.now();
const skills = scoreOfficialRepo(mk({ name: "skills" }), now);
const sdk = scoreOfficialRepo(mk({ name: "anthropic-sdk-python" }), now);
check("rank: skills repo outranks an SDK repo", skills > sdk);
check("rank: plugins repo scores above plain cookbook", scoreOfficialRepo(mk({ name: "claude-plugins-official" }), now) > scoreOfficialRepo(mk({ name: "other-tool" }), now));
check("rank: archived excluded", scoreOfficialRepo(mk({ name: "skills", archived: true }), now) === -Infinity);
check("rank: fork excluded", scoreOfficialRepo(mk({ name: "skills", fork: true }), now) === -Infinity);
check("rank: empty repo excluded", scoreOfficialRepo(mk({ name: "skills", size: 0 }), now) === -Infinity);
check("rank: fresh beats stale", scoreOfficialRepo(mk({ name: "x-skills", pushed_at: new Date(now).toISOString() }), now) > scoreOfficialRepo(mk({ name: "x-skills", pushed_at: new Date(now - 400 * 86_400_000).toISOString() }), now));

const tinyManifest = '{"name":"tiny-plugin","description":"Does one useful thing well","version":"0.1.0"}';
check("gate: a ~80 B real-world plugin.json is not a stub", scoreGene({ path: ".claude-plugin/plugin.json", kind: "plugin-manifest", name: "tiny-plugin", description: "Does one useful thing well", content: tinyManifest, rawUrl: null, size: tinyManifest.length, truncated: false }).verdict === "pass");
check("gate: a 30 B manifest is still a stub", scoreGene({ path: ".claude-plugin/plugin.json", kind: "plugin-manifest", name: "x", description: null, content: '{"name":"x","version":"1"}', rawUrl: null, size: 26, truncated: false }).verdict === "reject");
check("gate: mcp-config floor unchanged (200 B)", scoreGene({ path: ".mcp.json", kind: "mcp-config", name: "mcp", description: null, content: '{"mcpServers":{}}', rawUrl: null, size: 17, truncated: false }).verdict === "reject");

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
