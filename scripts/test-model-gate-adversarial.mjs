import { detectClaudeModels, detectModelFieldValue, isBlockedModelString, classifyVersion } from "../src/lib/claude-models";

// The TRUTH-ONTOLOGY adversarial round (2026-11-12): every case asserts reality.
// The old suite asserted a fictional registry (fable premium, 4.x blocked) —
// green tests for a lie. Now: Opus 4.5 is the strongest real model, the 4.x
// family IS the premium tier, and fictional strings are contamination.
const cases = [
  // [input, expectQualifying, expectFiction, expectBlocked, note]
  ["claude-opus-4-5", true, false, false, "opus 4.5 — the strongest real model"],
  ["opus 4.5", true, false, false, "spoken form"],
  ["claude opus 4,5", true, false, false, "comma decimal"],
  ["claude-opus-4-5-20251101", true, false, false, "dated snapshot pin"],
  ["claude_opus_4_5", true, false, false, "underscore"],
  ["opus4.5", true, false, false, "compact form"],
  ["claude-sonnet-4-5", true, false, false, "sonnet 4.5 real"],
  ["sonnet 4.5", true, false, false, "sonnet 4.5 spoken"],
  ["claude-haiku-4-5", true, false, false, "haiku 4.5 real"],
  ["claude-opus-4-1", true, false, false, "opus 4.1 real"],
  ["claude-sonnet-4", true, false, false, "sonnet 4 real"],
  ["claude-3-5-sonnet-20241022", true, false, false, "3.5 era real"],
  ["claude-3-7-sonnet", true, false, false, "3.7 real"],
  ["claude-3-opus", true, false, false, "opus 3 real (low weight)"],
  ["claude 4", true, false, false, "generic claude 4 — real era"],
  ["claude-fable", false, true, false, "FICTION: fable does not exist"],
  ["claude fable", false, true, false, "FICTION: context form"],
  ["fable model", false, true, false, "FICTION: model context"],
  ["fable 5.2", false, true, false, "FICTION: versioned pin"],
  ["claude-fable-5-5", false, true, false, "FICTION: the wave the radar once 'confirmed'"],
  ["claude-opus-5-5", false, true, false, "FICTION: opus 5.5 does not exist"],
  ["opus 5.5", false, true, false, "FICTION spoken"],
  ["claude-opus-6", false, true, false, "FICTION: opus 6"],
  ["claude-sonnet-6", false, true, false, "FICTION: sonnet 6"],
  ["claude-haiku-5", false, true, false, "FICTION: haiku 5"],
  ["claude 5", false, true, false, "FICTION: generic claude 5"],
  ["claude 6", false, true, false, "FICTION: generic claude 6"],
  ["claude 2", false, false, true, "BLOCKED: ancient era"],
  ["claude-2-1", false, false, true, "BLOCKED: claude 2.1"],
  ["opus 45", false, false, false, "maj>9 rejected — prose"],
  ["opus 4.25", false, false, false, "min>9 rejected — prose"],
  ["sonnet 55", false, false, false, "poem number, maj>9"],
  ["Shakespeare Sonnet 18", false, false, false, "poetry false positive"],
  ["Sonnet 55 by Shakespeare", false, false, false, "poetry 55"],
  ["Opus 6 wine tasting", false, false, false, "bare major prose invisible — the no-minor guard protects prose (X.Y form still fires fiction)"],
  ["my model costs opus 4.5 per mtok", true, false, false, "pricing context still real evidence"],
  ["mcp-config test for claude", false, false, false, "no model"],
];

let pass = 0, fail = 0;
for (const [input, eq, ef, eb, note] of cases) {
  const det = detectClaudeModels(input);
  const okQ = (det.qualifying.length > 0) === eq;
  const okF = (det.fiction.length > 0) === ef;
  const okB = (det.blocked.length > 0) === eb;
  const ok = okQ && okF && okB;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | "${input}" | qual=${det.qualifying.map((q) => q.id).join(",") || "-"} fict=${det.fiction.map((q) => q.id).join(",") || "-"} blocked=${det.blocked.map((q) => q.id).join(",") || "-"} | ${note}`);
}

// weight ladder — the real capability tier
const w = (text, id) => detectClaudeModels(text).qualifying.find((q) => q.id === id)?.weight;
const weightCases = [
  ["opus 4.5 pin", "claude-opus-4-5", 45, "opus 4.5 = 45 (the strongest)"],
  ["sonnet 4.5 pin", "claude-sonnet-4-5", 34, "sonnet 4.5 = 34"],
  ["haiku 4.5 pin", "claude-haiku-4-5", 26, "haiku 4.5 = 26"],
  ["opus 4.1 pin", "claude-opus-4-1", 30, "opus 4.1 = 30"],
  ["claude-sonnet-4 pin", "claude-sonnet-4", 24, "sonnet 4 = 24"],
  ["claude-3-5-sonnet-20241022 pin", "claude-3-5-sonnet", 14, "3.5 sonnet (3.x-era id format, family last) = 14"],
];
for (const [text, id, expect, note] of weightCases) {
  const got = w(text, id);
  const ok = got === expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | weight ${id} = ${got} (expect ${expect}) | ${note}`);
}

// classifyVersion fiction semantics
const cv = [
  [4.5, "opus", false, "4.5 opus = real"],
  [4.6, "opus", true, "4.6 opus = above real frontier = fiction for the gate"],
  [5, "opus", true, "opus 5 = fiction"],
  [5.5, "fable", true, "any fable = fiction"],
  [3.5, "sonnet", false, "3.5 sonnet = real"],
  [2, "generic", false, "claude 2 = blocked-era (not fiction)"],
  [5, "generic", true, "claude 5 = fiction"],
];
for (const [v, fam, expF, note] of cv) {
  const ok = classifyVersion(v, fam).fiction === expF;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | classifyVersion(${v}, ${fam}).fiction = ${!expF ? "false" : "true"} | ${note}`);
}

// model-field API: bare family names resolve to the REAL family frontier
const fv = [
  ["claude-opus-4-5", "claude-opus-4-5", "full id"],
  ["opus-4-5", "claude-opus-4-5", "no-prefix id"],
  ["opus", "claude-opus-4-5", "bare family → family frontier"],
  ["sonnet", "claude-sonnet-4-5", "bare sonnet → sonnet 4.5"],
  ["haiku", "claude-haiku-4-5", "bare haiku → haiku 4.5"],
  ["fable", null, "FICTION value → no model pinned"],
  ["claude-fable-5-2", null, "FICTION pin → no model pinned"],
  ["opus-5-5", null, "FICTION version → no model pinned"],
];
for (const [val, exp, note] of fv) {
  const got = detectModelFieldValue(val)?.id ?? null;
  const ok = got === exp;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | detectModelFieldValue('${val}') = ${got ?? "null"} | ${note}`);
}

// block-string API: fiction is blocked from filters too (no quota for hallucinations)
const bs = [
  ["sonnet 4.5", false, "real model — allowed"],
  ["opus 4.5", false, "real model — allowed"],
  ["opus 5.5", true, "fiction — blocked"],
  ["fable", true, "fiction — blocked"],
  ["claude 2", true, "ancient — blocked"],
];
for (const [val, exp, note] of bs) {
  const got = isBlockedModelString(val);
  const ok = got === exp;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | isBlockedModelString('${val}') = ${got} | ${note}`);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
