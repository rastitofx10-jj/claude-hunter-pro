/**
 * fable-5-2 detection test — verifies the hunter now correctly classifies
 * the new Fable 5.2 module strings as qualifying premium (not blocked).
 * Run: npx tsx scripts/fable-52-test.ts  (or via the server's compiled lib)
 */
import { classifyVersion, detectClaudeModels } from "../src/lib/claude-models";

let fails = 0;
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`);
  if (!cond) fails++;
};

// 1) version classification — the fable exception
const f52 = classifyVersion(5.2, "fable");
check("classifyVersion(5.2, fable) qualifying", f52.qualifying === true, `weight=${f52.weight}`);
check("classifyVersion(5.2, fable) weight 45", f52.weight === 45);
const f51 = classifyVersion(5.1, "fable");
check("classifyVersion(5.1, fable) qualifying", f51.qualifying === true);
const f49 = classifyVersion(4.9, "fable");
check("classifyVersion(4.9, fable) still blocked", f49.qualifying === false);

// 2) other families unaffected — the 5.5 gate holds
check("classifyVersion(5.2, opus) still blocked", classifyVersion(5.2, "opus").qualifying === false);
check("classifyVersion(5.5, opus) still qualifies", classifyVersion(5.5, "opus").qualifying === true);
check("classifyVersion(4.5, sonnet) still blocked", classifyVersion(4.5, "sonnet").qualifying === false);

// 3) end-to-end string detection — what the sweep actually sees in repos
const doc = `Model pin: claude-fable-5-2 (new default). Router compares claude-opus-5-5 vs claude-fable-5-2. Legacy: claude-fable-5-1, claude-sonnet-4-6.`;
const det = detectClaudeModels(doc);
const ids = det.qualifying.map((q) => q.id);
check("claude-fable-5-2 detected as qualifying", ids.includes("claude-fable-5-2"), `found: ${ids.join(", ")}`);
check("claude-fable-5-1 detected as qualifying", ids.includes("claude-fable-5-1"));
check("claude-opus-5-5 still detected", ids.includes("claude-opus-5-5"));
const blockedIds = det.blocked?.map((b) => b.id) ?? [];
check("claude-sonnet-4-6 still blocked", blockedIds.includes("claude-sonnet-4-6"), `blocked: ${blockedIds.join(", ")}`);

// 4) false-positive guard — prose about fables stays clean
const prose = "Claude wrote a fable about a tortoise. The fable story mentions Claude in passing.";
const detProse = detectClaudeModels(prose);
check("fable prose not detected", (detProse.qualifying ?? []).length === 0);

console.log(fails === 0 ? "\nALL_FABLE_TESTS_PASS" : `\n${fails} TEST(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
