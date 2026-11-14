/**
 * fable-5.2 detection test suite — the full wave package.
 *
 * Round 1 (fable-probe): registry entries + classifyVersion fable exception.
 * Round 2 (fable-wave): the field evidence that round 1 was NOT enough —
 *   the frontier queries retrieve repos whose only fable mention is prose
 *   ("written for fable 5.2", "tuned for fable-5-2") and the detector saw
 *   NOTHING; router repos (opus 4.5 + fable 5.2) were classified blockedOnly
 *   and HIDDEN from results — the hunter found the wave and then erased it.
 *   Frontier-model query hits also carried zero model evidence.
 *
 * This suite locks all of it: wave phrasings, false-positive guards,
 * settings pins, the blockedOnly rescue, and hard-evidence consolidation.
 *
 * Run: npx tsx --env-file=.env scripts/fable-52-test.ts
 */
import {
  classifyVersion,
  detectClaudeModels,
  detectModelFieldValue,
  isBlockedModelString,
  qualifyingModelOptions,
} from "../src/lib/claude-models";
import { computeListScore } from "../src/lib/github";
import { consolidateCandidates } from "../src/lib/deep-sweep";

let fails = 0;
let passes = 0;
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`);
  if (cond) passes++;
  else fails++;
};
const q = (t: string) => detectClaudeModels(t).qualifying.map((m) => m.id);
const b = (t: string) => detectClaudeModels(t).blocked.map((x) => x.id);

// ============================================================
// 1) version classification — the fable exception (regression)
// ============================================================
check("classifyVersion(5.2, fable) qualifying w45", (() => { const r = classifyVersion(5.2, "fable"); return r.qualifying && r.weight === 45; })());
check("classifyVersion(5.1, fable) qualifying", classifyVersion(5.1, "fable").qualifying === true);
check("classifyVersion(4.9, fable) still blocked", classifyVersion(4.9, "fable").qualifying === false);
check("classifyVersion(5.2, opus) still blocked", classifyVersion(5.2, "opus").qualifying === false);
check("classifyVersion(5.5, opus) still qualifies", classifyVersion(5.5, "opus").qualifying === true);
check("classifyVersion(4.5, sonnet) still blocked", classifyVersion(4.5, "sonnet").qualifying === false);

// ============================================================
// 2) registry pins (regression)
// ============================================================
const doc = `Model pin: claude-fable-5-2 (new default). Router compares claude-opus-5-5 vs claude-fable-5-2. Legacy: claude-fable-5-1, claude-sonnet-4-6.`;
check("claude-fable-5-2 pin detected", q(doc).includes("claude-fable-5-2"), `found: ${q(doc).join(",")}`);
check("claude-fable-5-1 pin detected", q(doc).includes("claude-fable-5-1"));
check("claude-opus-5-5 still detected", q(doc).includes("claude-opus-5-5"));
check("claude-sonnet-4-6 still blocked", b(doc).includes("claude-sonnet-4-6"));
check("date-suffixed id claude-fable-5-2-20261101", q("claude-fable-5-2-20261101 is the snapshot").includes("claude-fable-5-2"));

// ============================================================
// 3) THE WAVE — prose phrasings the frontier queries actually return
// ============================================================
check("A 'written for fable 5.2' (CLAUDE.md prose)", q("This skill is written for fable 5.2 — pin it in settings.").includes("claude-fable-5-2"), `found: ${q("This skill is written for fable 5.2 — pin it in settings.").join(",") || "NONE"}`);
check("B 'tuned for fable-5-2' (system-prompt prose)", q("system prompt tuned for fable-5-2, migrated from opus 4.5").includes("claude-fable-5-2"));
check("C 'fable-5.2 vs opus-5-5' (eval harness)", q("eval harness comparing fable-5.2 vs claude-opus-5-5 on 42 tasks").includes("claude-fable-5-2"));
check("E provider id anthropic/fable-5-2", q("uses anthropic/fable-5-2 via OpenRouter").includes("claude-fable-5-2"));
check("G 'Fable 5.2 is Anthropic's newest flagship'", q("Fable 5.2 is Anthropic's newest flagship. We benchmarked it.").includes("claude-fable-5-2"));

// ============================================================
// 4) blockedOnly rescue — routers mixing old + new were HIDDEN
// ============================================================
const routerDet = detectClaudeModels("model router: opus 4.5 for cheap tasks, fable 5.2 for hard ones");
check("H router repo NOT blockedOnly anymore", routerDet.blockedOnly === false, `qual=[${routerDet.qualifying.map((m) => m.id)}] blocked=[${routerDet.blocked.map((x) => x.id)}]`);
check("H router gets fable 5.2 credit", routerDet.qualifying.some((m) => m.id === "claude-fable-5-2"));
const routerScore = computeListScore({
  fullName: "acme/model-router",
  description: "model router: opus 4.5 for cheap tasks, fable 5.2 for hard ones",
  stars: 40, forks: 3, topics: ["llm"], pushedAt: new Date().toISOString(),
} as never);
check("computeListScore: router repo visible (blockedOnly=false)", routerScore.blockedOnly === false);
check("computeListScore: router reasons mention 5.5+ model", routerScore.reasons.some((r) => r.includes("5.5+ model")));
const oldRepo = computeListScore({
      fullName: "acme/legacy",
      description: "uses claude-sonnet-4-5 only",
      stars: 40, forks: 3, topics: [], pushedAt: new Date().toISOString(),
} as never);
check("computeListScore: 4.x-only repo still hidden (blockedOnly=true)", oldRepo.blockedOnly === true);

// ============================================================
// 5) settings pins — controlled model-field values
// ============================================================
check("settings value 'fable-5-2' → claude-fable-5-2", detectModelFieldValue("fable-5-2")?.id === "claude-fable-5-2");
check("settings value 'claude-fable-5-2' → itself", detectModelFieldValue("claude-fable-5-2")?.id === "claude-fable-5-2");
check("settings value 'fable' → family pin (own track)", detectModelFieldValue("fable")?.id === "claude-fable");
check("settings value 'claude-opus-5-5' → itself", detectModelFieldValue("claude-opus-5-5")?.id === "claude-opus-5-5");
check("settings value 'opus' → null (no version, below threshold)", detectModelFieldValue("opus") === null);
check("settings value 'sonnet' → null", detectModelFieldValue("sonnet") === null);
check("settings value 'gpt-4o' → null", detectModelFieldValue("gpt-4o") === null);
check('README snippet model: "fable" caught by prose detector', q('Set "model": "fable" in .claude/settings.json').includes("claude-fable"));

// ============================================================
// 6) false-positive guards — fable is also an English word
// ============================================================
check("story prose stays clean", q("Claude wrote a fable about a tortoise. The fable story mentions Claude in passing.").length === 0);
check("bare 'fable 5' (story list) not detected", q("fable 5: the tortoise and the hare").length === 0);
check("'fables 5' not detected", q("five fables 5 minutes each").length === 0);
check("'fable 5 lessons' not detected", q("a fable 5 lessons long").length === 0);
check("'fable 5.25' rejected by version sanitizer", q("fable 5.25 nonsense").length === 0);
check("'fable. 5.2 rating' not detected", q("a lovely fable. 5.2 stars on goodreads").length === 0);
check("haiku 5.2 still blocked (correctly)", b("haiku 5.2 test").includes("claude-haiku-5-2"));
check("opus 5.2 still blocked (correctly)", b("opus 5.2 test").includes("claude-opus-5-2"));

// ============================================================
// 7) filter gates — the server-side block on model strings
// ============================================================
check("filter 'fable 5.2' allowed", isBlockedModelString("fable 5.2") === false);
check("filter 'claude-fable-5-2' allowed", isBlockedModelString("claude-fable-5-2") === false);
check("filter 'fable' allowed (family)", isBlockedModelString("fable") === false);
check("filter 'opus 4.5' still blocked", isBlockedModelString("opus 4.5") === true);
check("filter 'claude-sonnet-4-5' still blocked", isBlockedModelString("claude-sonnet-4-5") === true);

// ============================================================
// 8) consolidation — frontier-model hits are HARD model evidence now
// ============================================================
const codeHits = [
  // a hit via the frontier query `fable 5.2 filename:CLAUDE.md`
  { path: "CLAUDE.md", repo: "acme/fable-adopters", capability: false, viaQuery: "fable 5.2 filename:CLAUDE.md" },
  // a hit via the router AND-query — evidence for BOTH named models
  { path: "router/config.yaml", repo: "acme/fable-adopters", capability: false, viaQuery: '"claude-opus-5-5" "claude-fable-5-2"' },
  // a hit via the skills frontier query (family, unregistered variant → normalized to claude-fable)
  { path: "skills/SKILL.md", repo: "acme/fable-adopters", capability: true, viaQuery: '"claude-fable-5" filename:SKILL.md' },
  // a capability query hit — must NOT fake model evidence (regression guard)
  { path: "README.md", repo: "acme/no-model", capability: true, viaQuery: "SKILL.md claude" },
  // a registry query hit — the classic path still works
  { path: "settings.json", repo: "acme/registry-pin", capability: false, viaQuery: "claude-fable-5-2" },
];
const candidates = consolidateCandidates(codeHits as never, []);
const byRepo = new Map(candidates.map((c) => [c.fullName, c]));
const adopters = byRepo.get("acme/fable-adopters");
check("frontier hit → hard evidence claude-fable-5-2", !!adopters && adopters.contentEvidence.includes("claude-fable-5-2"), `ev=[${adopters?.contentEvidence.join(",")}]`);
check("router AND-query → both models evidenced", !!adopters && adopters.contentEvidence.includes("claude-opus-5-5") && adopters.contentEvidence.includes("claude-fable-5-2"));
check("family skills query → normalized to claude-fable (registered weight)", !!adopters && adopters.contentEvidence.includes("claude-fable"));
check("adopters ranked as hard evidence", adopters?.evidence === "hard");
check("evidence path saved for audit", !!adopters && adopters.evidencePaths.includes("CLAUDE.md"));
check("capability hit does NOT fake model evidence", (byRepo.get("acme/no-model")?.contentEvidence.length ?? -1) === 0);
check("registry query path intact", byRepo.get("acme/registry-pin")?.contentEvidence.includes("claude-fable-5-2"));
check("adopters outscore the no-model repo", (adopters?.score ?? 0) > (byRepo.get("acme/no-model")?.score ?? 0), `adopters=${adopters?.score} no-model=${byRepo.get("acme/no-model")?.score}`);

// ============================================================
// 9) UI labels — fable own-track, no false 5.5+ on 5.1/5.2
// ============================================================
const opts = qualifyingModelOptions();
const f52 = opts.find((o) => o.value === "claude-fable-5-2");
const f55 = opts.find((o) => o.value === "claude-fable");
check("Fable 5.2 label shows own 5.x track", !!f52 && f52.label.includes("own 5.x track"), f52?.label);
check("family Fable label shows own 5.x track", !!f55 && f55.label.includes("own 5.x track"), f55?.label);
check("Opus 5.5 label still shows 5.5+", opts.find((o) => o.value === "claude-opus-5-5")?.label.includes("5.5+") === true);

console.log(`\n${fails === 0 ? `ALL_FABLE_WAVE_TESTS_PASS (${passes} checks)` : `${fails} TEST(S) FAILED of ${passes + fails}`}`);
process.exit(fails === 0 ? 0 : 1);
