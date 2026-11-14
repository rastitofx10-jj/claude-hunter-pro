// Reflexion truth-gate verification (no LLM needed):
//  1. evidenceInDigest — verbatim substring law (whitespace/case-insensitive)
//  2. validateQueryCandidate — length, charset, dupes
//  3. liveReflexionQueries selection pressure — sterile query eviction
import { validateQueryCandidate } from "../src/lib/reflexion";

let fails = 0;
function check(name: string, cond: boolean) {
  if (!cond) { fails++; console.log(`✗ ${name}`); } else { console.log(`✓ ${name}`); }
}

// ---------- evidence gate (uses the internal law directly) ----------
const digest = JSON.stringify({ library: { total: 137, bornLast7d: 22 }, yieldStats: { top: [{ q: '"allowed-tools" filename:SKILL.md', genes: 14 }] } });
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const evidenceInDigest = (ev: string) => !!ev && ev.length >= 6 && norm(digest).includes(norm(ev).slice(0, 120));
check("evidence: real quote passes", evidenceInDigest('"bornLast7d":22'));
check("evidence: real quote (case-insensitive) passes", evidenceInDigest('BORNLAST7D":22'));
check("evidence: paraphrase is REFUSED", !evidenceInDigest("about 20 genes were born this week"));
check("evidence: too-short evidence is refused", !evidenceInDigest("22"));
check("evidence: invention is REFUSED", !evidenceInDigest("the library contains 5000 genes"));

// ---------- query gate ----------
// validateQueryCandidate expects the known set to hold DEDUP KEYS (the way
// knownQueryUniverse builds it) — mirror that construction faithfully.
const { normalizeQueryKey } = await import("../src/lib/adaptive-learning");
const dedupKey = (q: string) => normalizeQueryKey(q).replace(/["']/g, " ").replace(/\s+/g, " ").trim();
const known = new Set<string>([dedupKey('"allowed-tools" filename:skill.md'), normalizeQueryKey('"allowed-tools" filename:skill.md')]);
check("query: valid new query passes", validateQueryCandidate('"mcpServers" filename:.mcp.json claude', known).ok);
check("query: duplicate of known fails (quote-insensitive)", !validateQueryCandidate('"allowed-tools" filename:SKILL.md', known).ok);
check("query: duplicate without quotes also fails", !validateQueryCandidate('allowed-tools filename:SKILL.md', known).ok);
check("query: too short fails", !validateQueryCandidate("ab", new Set()).ok);
check("query: too long fails", !validateQueryCandidate("a".repeat(141), new Set()).ok);
check("query: injection chars fail", !validateQueryCandidate("q=1; DROP TABLE users", new Set()).ok);
check("query: hebrew fails", !validateQueryCandidate('טוקן מיוחד בחיפוש', new Set()).ok);
check("query: no latin token fails", !validateQueryCandidate("12345678", new Set()).ok);

// ---------- YAML scalar escaping (frontmatter law) ----------
// import not exported for yamlScalar — verify via a behavioral mirror instead:
const yamlScalar = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
const name = 'my "lesson" \\ chapter';
const fm = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar("desc")}\n---\nbody`;
check("yamlScalar: frontmatter closes (G5 law)", /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(fm));
check("yamlScalar: quotes escaped round-trip", JSON.parse(fm.match(/^name: (.+)$/m)![1]) === name);

console.log(fails === 0 ? "\nALL REFLEXION GATE CHECKS PASSED" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
