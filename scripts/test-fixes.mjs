// Test 1: normalizeFrontmatterFence against the REAL AI output shape (from diag)
function stripOuterFence(raw) {
  const m = raw.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : raw;
}
function normalizeFrontmatterFence(raw) {
  const m = raw.match(/^```(?:yaml|markdown|md)?\s*\n([\s\S]*?)\n```\s*\n?/);
  if (!m) return raw;
  const block = m[1] ?? "";
  if (!/^name:|^description:/m.test(block)) return raw;
  const rest = raw.slice(m[0].length);
  return block.startsWith("---") ? block + "\n" + rest : `---\n${block}\n---\n\n${rest}`;
}
const aiOutput = "```yaml\nname: m365-bridge-due-diligence\ndescription: Comprehensive due diligence analysis\n```\n\n# M365 Bridge Due Diligence Skill\n\n## Role\nYou are a specialized analyst.\n\n" + "x".repeat(400);
const normalized = normalizeFrontmatterFence(stripOuterFence(aiOutput));
console.log("TEST1 normalize:", /^---/.test(normalized) && normalized.length > 200 ? "PASS (would be source=ai)" : "FAIL");
console.log("  head:", JSON.stringify(normalized.slice(0, 90)));

// Test 2: validator against REAL gen5 dead queries (all repo:anthropic-ai/claude — 0 hits)
const realRepos = new Set(["simonw/llm-anthropic", "anthropics/claude-code", "anthropics/skills", "kilimcininkoroglu/m365bridge"]);
const deadQueries = [
  'repo:anthropic-ai/claude "4.5" in:code',
  'repo:anthropic-ai/claude "premium model" in:readme',
  'repo:anthropic-ai/claude "model family" in:readme',
];
function validateEvolvedQueries(rawQueries, realRepos, deadQueries, maxKeep = 10) {
  const deadPatterns = deadQueries.map((d) => d.replace(/["']/g, "").split(/\s+/).filter((w) => w.length > 3)).filter((w) => w.length > 0);
  const kept = [];
  const dropped = [];
  for (const raw of rawQueries) {
    const q = String(raw ?? "").trim();
    if (q.length < 8 || q.length > 240) { dropped.push({ q, why: "length" }); continue; }
    const repoMatch = q.match(/\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (repoMatch && !realRepos.has(repoMatch[1].toLowerCase())) { dropped.push({ q, why: `repo:${repoMatch[1]} not real` }); continue; }
    const bare = q.replace(/["']/g, "").toLowerCase();
    const isDead = deadPatterns.some((dw) => dw.length >= 2 && dw.every((w) => bare.includes(w.toLowerCase())));
    if (isDead) { dropped.push({ q, why: "dead pattern" }); continue; }
    if (kept.some((k) => k.toLowerCase() === bare)) { dropped.push({ q, why: "dup" }); continue; }
    kept.push(q);
    if (kept.length >= maxKeep) break;
  }
  return { kept, dropped };
}
const gen6Proposals = [
  'repo:anthropic-ai/claude "model_name" in:code',
  'repo:anthropic-ai/claude "model_version" in:code',
  'repo:simonw/llm-anthropic "claude-opus-4-5" in:file',
  'repo:anthropics/claude-code "4.5" in:file',
  '"ANTHROPIC_MODEL" "claude-opus-4-5" language:python',
  'path:.claude/skills "opus 4.5"',
];
const { kept, dropped } = validateEvolvedQueries(gen6Proposals, realRepos, deadQueries);
console.log("TEST2 validator:");
for (const d of dropped) console.log(`  DROPPED [${d.why}] ${d.q.slice(0, 70)}`);
for (const k of kept) console.log(`  KEPT ${k.slice(0, 70)}`);
console.log(kept.length === 4 && dropped.length === 2 ? "PASS" : "CHECK");
