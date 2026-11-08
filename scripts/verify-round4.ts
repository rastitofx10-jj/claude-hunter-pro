/**
 * verify-round4.ts — one-command verification suite (round 4).
 *
 * Runs with bun (native TS):  bun run verify
 * Two layers:
 *   A. UNIT — pure core functions (model gate, scoring, JSON repair, parsing).
 *   B. API  — live smoke tests against the dev server on :3000
 *             (skipped gracefully if the server is down).
 * The script never touches any real GitHub token.
 */
import {
  detectClaudeModels,
  isBlockedModelString,
  qualifyingModelOptions,
} from "../src/lib/claude-models";
import { tierOf, parseRepoInput, computeListScore } from "../src/lib/github";
import {
  extractJson,
  safeJsonParse,
  sanitizeSlug,
  stripFences,
  stripOuterFence,
  AiJsonError,
} from "../src/lib/ai-json";

// ---------- tiny harness ----------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ---------- A. UNIT ----------
section("A. UNIT — model gate (5.5+ only, 4.x blocked)");

const d1 = detectClaudeModels("Built with claude-opus-5-5 and Claude Fable, max_tokens 4096");
ok(d1.qualifying.some((m) => m.id === "claude-opus-5-5"), "opus-5-5 detected");
ok(d1.qualifying.some((m) => m.id === "claude-fable"), "fable detected via claude-fable string");
ok(d1.blocked.length === 0, "no blocked hits when only qualifying present");

const d2 = detectClaudeModels("We use claude-opus-4-5 and claude-sonnet-4 exclusively");
ok(d2.qualifying.length === 0, "4.x family does not qualify");
ok(d2.blocked.length > 0, "4.x reported as blocked");
ok(d2.blockedOnly === true, "blockedOnly flag set");

ok(isBlockedModelString("claude-opus-4-5") === true, "isBlockedModelString: 4.5 blocked");
ok(isBlockedModelString("claude-opus-5-5") === false, "isBlockedModelString: 5.5 allowed");
ok(isBlockedModelString("") === false, "isBlockedModelString: empty is not blocked");

const d3 = detectClaudeModels("claude 6 is fine but claude 5 is below");
ok(d3.qualifying.some((m) => m.id === "claude-6"), "bare claude 6 qualifies (6.0 >= 5.5)");
ok(d3.blocked.some((b) => b.id === "claude-5"), "bare claude 5 blocked (5.0 < 5.5)");

const d4 = detectClaudeModels("cost 45 dollars, opus 45 is not a version");
ok(!d4.qualifying.some((m) => m.version === 45) && !d4.blocked.some((b) => b.version === 45), "two-digit non-version (45) not treated as a model version");

const opts = qualifyingModelOptions();
ok(opts.length >= 6, "qualifyingModelOptions derived from registry only");
ok(!opts.some((o) => o.label.includes("4.")), "4.x never leaks into UI options");

section("A. UNIT — tiers and scoring");
ok(tierOf(100).key === "elite" && tierOf(80).key === "elite", "tierOf: 80+ elite");
ok(tierOf(79).key === "gold", "tierOf: 79 gold");
ok(tierOf(0).key === "seed", "tierOf: 0 seed");

const s1 = computeListScore({
  fullName: "a/b",
  description: "claude code agent built with claude-opus-5-5",
  stars: 1200,
  forks: 40,
  pushedAt: new Date().toISOString(),
});
ok(s1.score > 0 && s1.score <= 100, `computeListScore in range (${s1.score})`);
ok(s1.blockedOnly === false, "qualifying mention → not blockedOnly");

const s2 = computeListScore({
  fullName: "a/c",
  description: "only claude-opus-4-5 here",
  stars: 10,
  forks: 0,
});
ok(s2.blockedOnly === true, "4.x-only repo flagged blockedOnly (hidden by API)");

section("A. UNIT — repo input parsing");
ok(parseRepoInput("github.com/owner/repo")?.repo === "repo", "github.com/owner/repo");
ok(parseRepoInput("https://github.com/owner/repo.git?tab=readme")?.owner === "owner", "full URL with .git and query");
ok(parseRepoInput("owner/repo/")?.repo === "repo", "trailing slash");
ok(parseRepoInput("onlyname") === null, "missing owner → null");
ok(parseRepoInput("bad path!/x") === null, "weird chars → null");

section("A. UNIT — AI JSON extraction & repair");
const j1 = extractJson('```json\n{"a": 1,}\n```');
ok(j1.a === 1, "fenced + trailing comma repaired");
const j2 = extractJson('prose before {"paste":"do "X": now", "b": 2} prose after');
ok((j2 as { paste?: string }).paste === 'do "X": now', "inner quotes escaped correctly");
const j3 = extractJson('[1,2,{"x":3}]');
ok(Array.isArray((j3 as { items?: unknown[] }).items) && (j3 as { items: unknown[] }).items.length === 3, "top-level array wrapped as {items}");
let threw = false;
try {
  extractJson("no json here at all");
} catch (e) {
  threw = e instanceof AiJsonError;
}
ok(threw, "no JSON → AiJsonError");
ok(safeJsonParse("[broken", []) instanceof Array && safeJsonParse("[broken", []).length === 0, "safeJsonParse fallback");
ok(sanitizeSlug("בונה מסכים Fast!!") === "" || /^[a-z0-9-_]*$/.test(sanitizeSlug("בונה מסכים Fast!!")), "sanitizeSlug strips non-ascii");
ok(sanitizeSlug("My Cool Skill", "fallback") === "my-cool-skill", "sanitizeSlug kebab-case");
ok(stripFences("```json\n{\"a\":1}\n```") === "{\"a\":1}", "stripFences removes outer fence");
ok(stripOuterFence("```\n# h\n```bash\nls\n```\n```") .includes("```bash"), "stripOuterFence keeps internal fences");

// ---------- B. API ----------
section("B. API — smoke tests against :3000");

const BASE = "http://localhost:3000";
let serverUp = false;
try {
  const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) });
  serverUp = res.ok;
} catch {
  serverUp = false;
}
if (!serverUp) {
  console.log("  (dev server not reachable — API layer skipped)");
} else {
  const j = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body: body as Record<string, unknown> | null };
  };

  // health of every read route
  const reads: [string, string][] = [
    ["/api/live-hunt", "stageOrder present"],
    ["/api/mission", "items+stats"],
    ["/api/watchlist", "items"],
    ["/api/history", "items"],
    ["/api/dna-library", "items"],
    ["/api/genesis/chimeras", "items"],
    ["/api/sweep", "items"],
    ["/api/rate-limit", "hasToken field"],
  ];
  for (const [path, note] of reads) {
    const r = await j(path);
    ok(r.status === 200 && r.body !== null, `GET ${path} → 200 (${note})`, `got ${r.status}`);
  }
  const huntBody = (await j("/api/live-hunt")).body;
  ok(Array.isArray((huntBody as { stageOrder?: unknown[] })?.stageOrder) && (huntBody as { stageOrder: unknown[] }).stageOrder.length === 8, "live-hunt exposes 8-stage order");

  // validation & error semantics (round-4 behaviors)
  ok((await j("/api/search", { method: "POST", body: JSON.stringify({ mode: "code", query: "" }) })).status === 400, "search: code mode without term → 400");
  ok((await j("/api/search", { method: "POST", body: JSON.stringify({ mode: "repos", query: "x", model: "claude-opus-4-5" }) })).status === 400, "search: blocked 4.x model → 400 (iron threshold)");
  ok((await j("/api/live-hunt", { method: "POST", body: JSON.stringify({}) })).status === 400, "live-hunt: no action → 400");
  ok((await j("/api/dna-library/0")).status === 400, "dna-library/0 → 400 (id>0 guard)");
  ok((await j("/api/dna-library/999999")).status === 404, "dna-library/999999 → 404");
  ok((await j("/api/dna-library", { method: "DELETE" })).status === 400, "dna-library DELETE without ?all=1/?repo → 400 (wipe guard)");
  ok((await j("/api/mission/999999", { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status === 404, "mission PATCH missing → 404");
  const rl = await j("/api/mission/-1/autopilot/step", { method: "POST" });
  ok(rl.status === 400, "autopilot step with id -1 → 400");
  const csrf = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ mode: "repos", query: "x" }),
  });
  ok(csrf.status === 403, "cross-origin mutation blocked by middleware (403)");
}

// ---------- summary ----------
console.log(`\n========================================`);
console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
if (failures.length) {
  console.log("  Failures:");
  for (const f of failures) console.log(`   - ${f}`);
}
console.log(`========================================`);
process.exit(failed === 0 ? 0 : 1);
