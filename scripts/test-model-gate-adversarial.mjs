// Adversarial test of the model gate against the REAL lineup (Claude Platform docs, 2026-11):
//   Mythos tier  Fable 5.2 / Mythos 5.2 (+ 5.1, 5)    Opus 5.5    Sonnet 5.5    Haiku 5.5
//   below the 5.5+ threshold: the whole 4.x family, Opus 5, Sonnet 5, 3.x, Claude 1/2
//   unverified: anything above the known lineup (opus 6), unknown families
// Run:  node scripts/test-model-gate-adversarial.mjs   (Node >= 22.18 or Bun)
import {
  detectClaudeModels,
  detectModelFieldValue,
  isBlockedModelString,
  classifyVersion,
  frontierModels,
} from "../src/lib/claude-models.ts";

let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
};

// [text, qualifyingIds[], blockedCount>0, unverifiedCount>0]
const detect = [
  ["claude-opus-5-5", ["claude-opus-5-5"], false, false],
  ["Opus 5.5 is great", ["claude-opus-5-5"], false, false],
  ["model: claude-sonnet-5-5", ["claude-sonnet-5-5"], false, false],
  ["claude-haiku-5-5", ["claude-haiku-5-5"], false, false],
  ["claude-fable-5-2", ["claude-fable-5-2"], false, false],
  ["claude fable 5.1", ["claude-fable-5-1"], false, false],
  ["claude-mythos-5-2", ["claude-mythos-5-2"], false, false],
  ["claude-opus-5-5-20260922", ["claude-opus-5-5"], false, false],
  ["claude-opus-4-5", [], true, false],
  ["claude-opus-4-8", [], true, false],
  ["claude-sonnet-4-6", [], true, false],
  ["claude-haiku-4-5", [], true, false],
  ["claude-opus-5", [], true, false],
  ["claude-sonnet-5", [], true, false],
  ["claude-3-5-sonnet-20241022", [], true, false],
  ["claude-opus-6", [], false, true],
  ["opus 6.5", [], false, true],
  ["claude-fable-9-9", [], false, true],
  ["opus 5.5 with sonnet 4.5 fallback", ["claude-opus-5-5"], true, false],
  ["the opus 4 chapters of the book", [], false, false],
];
for (const [text, q, blocked, unverified] of detect) {
  const d = detectClaudeModels(text);
  const ids = d.qualifying.map((m) => m.id).sort();
  const ok =
    JSON.stringify(ids) === JSON.stringify([...q].sort()) &&
    d.blocked.length > 0 === blocked &&
    d.fiction.length > 0 === unverified;
  check(`detect(${JSON.stringify(text)}) → q=${ids.join(",") || "-"} blocked=${d.blocked.length} unverified=${d.fiction.length}`, ok);
}

// classifyVersion
const cv = [
  [5.5, "opus", true, false],
  [5.5, "sonnet", true, false],
  [5.5, "haiku", true, false],
  [5.2, "fable", true, false],
  [5.2, "mythos", true, false],
  [4.5, "opus", false, false],
  [5, "opus", false, false],
  [6, "opus", false, true],
  [5.6, "sonnet", false, true],
  [4, "fable", false, true],
  [5.5, "generic", true, false],
  [4, "generic", false, false],
  [7, "generic", false, true],
];
for (const [v, fam, q, f] of cv) {
  const r = classifyVersion(v, fam);
  check(`classifyVersion(${v}, ${fam}) → q=${r.qualifying} unverified=${r.fiction}`, r.qualifying === q && r.fiction === f);
}

// weights: Mythos tier > Opus > Sonnet > Haiku, cap 45
const w = (t) => detectClaudeModels(t).qualifying[0]?.weight ?? 0;
check("weight ladder fable-5-2 >= opus-5-5 > sonnet-5-5 > haiku-5-5",
  w("claude-fable-5-2") >= w("claude-opus-5-5") && w("claude-opus-5-5") > w("claude-sonnet-5-5") && w("claude-sonnet-5-5") > w("claude-haiku-5-5"));
check("no weight above the 45 cap", ["claude-fable-5-2", "claude-mythos-5-2", "claude-opus-5-5"].every((t) => w(t) <= 45));

// controlled model fields (settings.json "model", ANTHROPIC_MODEL)
const fv = [
  ["claude-opus-5-5", "claude-opus-5-5"],
  ["opus", "claude-opus-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
  ["fable", "claude-fable-5-2"],
  ["claude-fable-5-2", "claude-fable-5-2"],
  ["claude-opus-4-5", null],
  ["opus-6", null],
  ["", null],
];
for (const [val, exp] of fv) {
  const got = detectModelFieldValue(val)?.id ?? null;
  check(`detectModelFieldValue(${JSON.stringify(val)}) = ${got}`, got === exp);
}

// filters: below-threshold and unverified filter values are blocked server-side
const bs = [
  ["claude-opus-5-5", false],
  ["claude-fable-5-2", false],
  ["fable", false],
  ["claude-opus-4-5", true],
  ["claude-sonnet-4-5", true],
  ["claude 2", true],
  ["claude-opus-6", true],
  ["", false],
];
for (const [val, exp] of bs) check(`isBlockedModelString(${JSON.stringify(val)}) = ${isBlockedModelString(val)}`, isBlockedModelString(val) === exp);

// hunt budget: only frontier models steer queries
const fr = frontierModels().map((m) => m.id).sort();
check(`frontierModels() = ${fr.join(", ")}`,
  JSON.stringify(fr) === JSON.stringify(["claude-fable-5-2", "claude-haiku-5-5", "claude-mythos-5-2", "claude-opus-5-5", "claude-sonnet-5-5"]));

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
