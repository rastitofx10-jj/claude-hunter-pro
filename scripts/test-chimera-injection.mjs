// Regression: chimera injection — quality gate + adaptive learning
import { scoreGene, gateArtifacts } from "../src/lib/quality-gate.ts";
import { normalizeQueryKey, yieldWeight, rankByYield } from "../src/lib/adaptive-learning.ts";

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"} | ${name}`); };

// --- quality gate ---
const mk = (over = {}) => ({
  path: ".claude/skills/x/SKILL.md", kind: "skill", name: "my-skill",
  description: "Does something useful for the agent", content: null, rawUrl: null, size: 100, truncated: false, ...over
});

// 1. stub rejected
const stub = scoreGene(mk({ content: "tiny" }));
t("stub (11B) rejected with reason", stub.verdict === "reject" && stub.reasons.some(r => r.startsWith("stub:")));

// 2. rich skill passes with high score
const rich = mk({
  content: "---\nname: my-skill\ndescription: Does something useful\n---\n\n# My Skill\n\n## Usage\n\n- step one\n- step two\n\n```bash\nrun it\n```\n\n" + "x".repeat(3000)
});
const richScored = scoreGene(rich);
t("rich skill passes >= 0.8", richScored.verdict === "pass" && richScored.score >= 0.8);

// 3. structured but short → passes on structure (>= 0.6)
const short = mk({
  content: "---\nname: my-skill\ndescription: Does something useful\n---\n\n## Usage\n- one\n- two\n" + "y".repeat(400)
});
const shortScored = scoreGene(short);
t("short structured command passes >= 0.6", shortScored.verdict === "pass" && shortScored.score >= 0.6);

// 4. generic name penalized
const generic = scoreGene(mk({ name: "README", content: "z".repeat(2000) }));
t("generic name gets uniqueness 0", generic.score < richScored.score && generic.reasons.some(r => r.startsWith("generic name")));

// 5. invalid mcp-config rejected
const badJson = scoreGene(mk({ kind: "mcp-config", path: ".mcp.json", content: "{not json" }));
t("invalid JSON mcp-config rejected", badJson.verdict === "reject");

// 6. valid mcp-config with substance passes
const okJson = scoreGene(mk({
  kind: "mcp-config", path: ".mcp.json",
  content: JSON.stringify({ mcpServers: { a: { command: "npx", args: ["-y", "x"] }, b: { command: "node", args: ["y"] } }, extra: "z".repeat(500) })
}));
t("valid JSON mcp-config passes", okJson.verdict === "pass");

// 7. gateArtifacts aggregates
const gated = gateArtifacts([mk({ content: "tiny" }), rich, short]);
t("gateArtifacts: 2 kept, 1 rejected, avgScore present", gated.kept.length === 2 && gated.rejected.length === 1 && gated.avgScore !== null && gated.avgScore > 0);

// --- adaptive learning ---
t("date normalization", normalizeQueryKey("claude skills created:>2026-09-11 stars:>=1") === "claude skills created:>{date} stars:>=1");
t("case+space normalization", normalizeQueryKey("  SKILL.md claude ") === "skill.md claude");

const stats = {
  "claude skills created:>{date}": { runs: 4, genes: 20, lastRun: "2026-11-10" },
  "dead query": { runs: 3, genes: 0, lastRun: "2026-11-10" },
};
t("unseen query weight = 0.5", yieldWeight("never seen", stats) === 0.5);
t("proven query weight > unseen", yieldWeight("claude skills created:>2026-03-04", stats) > 0.5);
t("dead query weight < unseen", yieldWeight("dead query", stats) < 0.5);

const ranked = rankByYield([
  { q: "dead query" }, { q: "fresh unseen" }, { q: "claude skills created:>2026-01-01" }
], stats);
t("ranking: proven first, dead last", ranked[0].q.startsWith("claude skills") && ranked[2].q === "dead query");
const tieRanked = rankByYield([{ q: "a-new" }, { q: "b-new" }, { q: "c-new" }], stats);
t("ties keep original order (rotation preserved)", tieRanked.map(x => x.q).join(",") === "a-new,b-new,c-new");

console.log(`\n${fail === 0 ? "ALL_GREEN" : "HAS_FAILURES"} | ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
