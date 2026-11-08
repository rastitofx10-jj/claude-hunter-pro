import { detectClaudeModels, isBlockedModelString } from "../src/lib/claude-models";

const cases = [
  // [input, expectQualifying, expectBlocked, note]
  ["claude-fable", true, false, "basic fable"],
  ["claude fable", true, false, "fable with space"],
  ["fable model", true, false, "fable context"],
  ["fable", false, false, "bare fable must NOT qualify"],
  ["claude-opus-5-5", true, false, "opus 5.5"],
  ["opus 5,5", true, false, "comma decimal"],
  ["claude 5", false, true, "bare claude 5 = 5.0 blocked"],
  ["claude 6", true, false, "claude 6 qualifies"],
  ["sonnet 4.5", false, true, "sonnet 4.5 blocked"],
  ["claude-opus-4-5-20251101", false, true, "date suffix"],
  ["opus 45", false, false, "maj>9 rejected"],
  ["claude opus 45 dollars", false, false, "price context"],
  ["sonnet 55", false, false, "sonnet 55 poem number"],
  ["Opus 6 wine tasting", true, false, "FALSE POSITIVE RISK: wine brand"],
  ["Shakespeare Sonnet 18", false, false, "poetry false positive"],
  ["Sonnet 55 by Shakespeare", false, false, "poetry 55"],
  ["opus 6 vodka", true, false, "FALSE POSITIVE RISK: vodka"],
  ["claude-3-5-sonnet-20241022", false, true, "3.5 sonnet blocked"],
  ["haiku-4-5", false, true, "haiku 4.5 blocked"],
  ["my model costs opus 5.5 per mtok", true, false, "pricing context"],
  ["mcp-config test for claude", false, false, "no model"],
];

let pass = 0, fail = 0;
for (const [input, eq, eb, note] of cases) {
  const det = detectClaudeModels(input);
  const okQ = det.qualifying.length > 0 === eq;
  const okB = det.blocked.length > 0 === eb;
  const ok = okQ && okB;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | "${input}" | qual=${det.qualifying.map(q=>q.id).join(",")||"-"} blocked=${det.blocked.map(b=>b.id).join(",")||"-"} | ${note}`);
}
console.log(`\n${pass} pass / ${fail} fail`);

// block-string API behavior
console.log("\nisBlockedModelString('sonnet 4.5') =", isBlockedModelString("sonnet 4.5"));
console.log("isBlockedModelString('opus 5.5') =", isBlockedModelString("opus 5.5"));
process.exit(fail > 0 ? 1 : 0);
