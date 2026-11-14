// test-frontier-families.ts — adversarial validation of frontier detection for
// the opus / sonnet / haiku / fable / mythos families against the REAL registry
// lines.
//
// round 12 (TRUTH FIX): this suite was still written against the RETIRED
// registry (frontier 4.5, fable = fiction) while the live registry had moved to
// the 2026-11-13 policy (opus/sonnet/haiku 5.5; fable/mythos are REAL Mythos-tier
// families at 5.2). It was pushed red — 31 pass / 39 fail at HEAD — while the
// repo's audit trail claimed a green suite. Rewritten against the CURRENT lines:
//
// Real frontier lines under test (familyFrontier from the real registry):
//   opus / sonnet / haiku → 5.5   (registered: opus 5.5 w42, sonnet 5.5 w36, haiku 5.5 w28)
//   fable / mythos        → 5.2   (Mythos tier, qualifying from v5; registered 5.2 w45, 5.1 w44, 5 w43)
//   below-threshold reals (opus 5, sonnet 5, 4.x, 3.x, 1/2) are BLOCKED — detected, never credited.
//
// The property under attack, per family:
//   1. RADAR: a pin ABOVE the real line (5.6+, or fable/mythos 5.3+) emerges in
//      every real-world phrasing; a pin AT or BELOW the line never does.
//   2. GATE agreement: real models get the real ladder weights; pins above the
//      line are FICTION for the gate (weight 0, unverified flag) — only the
//      authority-gated radar may promote a real future release.
//   3. Prose immunity: Shakespeare sonnets, Basho haiku, syllable counts and
//      magnum-opus chapters never create a frontier signal.
import {
  detectClaudeModels,
  detectModelFieldValue,
  isBlockedModelString,
  type ClaudeModelDef,
} from "../src/lib/claude-models";
import { detectEmergingModels, waveQueriesFor } from "../src/lib/emerging-models";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`PASS | ${name}${detail ? ` | ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ""}`); }
};
const ids = (text: string) => detectEmergingModels(text).map((s) => s.id);
const emerges = (text: string, id: string) => ids(text).includes(id);
const qualWeight = (text: string, id: string): number | undefined =>
  detectClaudeModels(text).qualifying.find((q: ClaudeModelDef) => q.id === id)?.weight;
const fictionIn = (text: string) => detectClaudeModels(text).fiction.length > 0;
const blockedIn = (text: string, id: string) =>
  detectClaudeModels(text).blocked.some((b) => b.id === id);

// ============================================================
// 1. OPUS — real line 5.5 (registered weight 42)
// ============================================================
{
  // every real-world phrasing of the NEXT opus (5.6) must emerge
  check("opus 5.6 bare X.Y emerges", emerges("benchmarked against opus 5.6 last night", "claude-opus-5-6"));
  check("claude-opus-5-6 pin emerges", emerges('"model": "claude-opus-5-6"', "claude-opus-5-6"));
  check("opus 5,6 comma decimal emerges", emerges("tuned for opus 5,6 in production", "claude-opus-5-6"));
  check("claude_opus_5_6 underscore emerges", emerges("claude_opus_5_6 settings key", "claude-opus-5-6"));
  check("opus5.6 compact form emerges", emerges("upgrade to opus5.6 today", "claude-opus-5-6"));
  check("claude-opus-5-6-20260101 date suffix emerges", emerges("claude-opus-5-6-20260101 snapshot pin", "claude-opus-5-6"));
  check("claude-opus-6 major-only (prefixed) emerges", emerges("claude-opus-6 just launched", "claude-opus-6"));
  check("opus 6.1 two notches up emerges", emerges("opus 6.1 benchmarks leaked", "claude-opus-6-1"));

  // at-or-below the real line: never emerging
  check("opus 5.4 (below line) does NOT emerge", ids("opus 5.4 comparison").length === 0);
  check("claude-opus-5-5 (= the real line) does NOT emerge", ids("claude-opus-5-5 release").length === 0);
  check("opus 4.5 (legacy real) does NOT emerge", ids("opus 4.5 is current").length === 0);
  check("bare 'opus 6' (no prefix, no minor) does NOT emerge", ids("opus 6").length === 0);

  // gate agreement for opus
  check("opus 5.5 gate-qualifies at weight 42 (the strongest real opus)", qualWeight("opus 5.5 pin", "claude-opus-5-5") === 42);
  check("opus 5 is real-but-blocked (below the 5.5 threshold)", blockedIn("claude-opus-5 pin", "claude-opus-5"));
  check("opus 4.5 legacy is blocked, never credited", blockedIn("claude-opus-4-5 pin", "claude-opus-4-5"));
  check("opus 5.6 gate-fiction (above the real line — radar's job)", fictionIn("opus 5.6 pin"));
  check("opus 6 gate-fiction", fictionIn("claude-opus-6 is out"));
  check("opus 5.5 gate-real (no fiction flag)", !fictionIn("claude-opus-5-5 everywhere"));
}

// ============================================================
// 2. SONNET — real line 5.5 (registered weight 36)
// ============================================================
{
  check("sonnet 5.6 bare X.Y emerges", emerges("written for sonnet 5.6, fast and cheap", "claude-sonnet-5-6"));
  check("claude-sonnet-5-6 pin emerges", emerges('"model": "claude-sonnet-5-6"', "claude-sonnet-5-6"));
  check("sonnet-5-6 hyphenated bare emerges", emerges("router defaults to sonnet-5-6", "claude-sonnet-5-6"));
  check("claude-sonnet-6 major-only (prefixed) emerges", emerges("claude-sonnet-6 announced", "claude-sonnet-6"));
  check("sonnet 6.2 two notches up emerges", emerges("sonnet 6.2 eval results", "claude-sonnet-6-2"));

  check("sonnet 5.5 (AT the real line) does NOT emerge", ids("sonnet 5.5 is current").length === 0);
  check("claude-sonnet-5-5 does NOT emerge", ids('"claude-sonnet-5-5"').length === 0);
  check("sonnet 5 (below threshold) does NOT emerge", ids("claude-sonnet-5 fallback").length === 0);
  check("claude-3-5-sonnet (legacy real format) does NOT emerge", ids("claude-3-5-sonnet-20241022").length === 0);
  check("bare 'sonnet 6' (no prefix, no minor) does NOT emerge", ids("sonnet 6").length === 0);
  check("sonnet 5.4 (below line) does NOT emerge", ids("sonnet 5.4 leak").length === 0);

  // gate agreement for sonnet
  check("sonnet 5.5 gate-qualifies at 36 (real ladder)", qualWeight("sonnet 5.5 pin", "claude-sonnet-5-5") === 36);
  check("sonnet 5 is real-but-blocked", blockedIn("claude-sonnet-5 pin", "claude-sonnet-5"));
  check("sonnet 5.6 gate-fiction (above line)", fictionIn("sonnet 5.6 pin"));
  check("sonnet 3.5 legacy blocked (3.x-era id format)", blockedIn("claude-3-5-sonnet-20241022 pin", "claude-3-5-sonnet"));
}

// ============================================================
// 3. HAIKU — real line 5.5 (registered weight 28)
// ============================================================
{
  check("haiku 5.6 bare X.Y emerges", emerges("cheap tier runs haiku 5.6", "claude-haiku-5-6"));
  check("claude-haiku-5-6 pin emerges", emerges('"model": "claude-haiku-5-6"', "claude-haiku-5-6"));
  check("claude-haiku-6 major-only (prefixed) emerges", emerges("claude-haiku-6 released", "claude-haiku-6"));

  check("haiku 5.5 (AT the real line) does NOT emerge", ids("haiku 5.5 current").length === 0);
  check("claude-haiku-5-5 does NOT emerge", ids('"claude-haiku-5-5"').length === 0);
  check("haiku 4.5 (legacy real) does NOT emerge", ids("claude-3-5-haiku fallback").length === 0);
  check("bare 'haiku 6' (syllables, no minor) does NOT emerge", ids("haiku 6 syllables per line").length === 0);

  // gate agreement for haiku
  check("haiku 5.5 gate-qualifies at 28 (real ladder)", qualWeight("haiku 5.5 pin", "claude-haiku-5-5") === 28);
  check("haiku 5.6 gate-fiction (above line)", fictionIn("haiku 5.6 pin"));
}

// ============================================================
// 4. FABLE / MYTHOS — REAL Mythos-tier families (line 5.2, weight 45)
//    round 12: under the retired registry fable was pure fiction; the
//    2026-11-13 policy registers it as the strongest real tier.
// ============================================================
{
  check("fable 5.3 (above the 5.2 line) emerges on the radar", emerges("written for fable 5.3", "claude-fable-5-3"));
  check("mythos 5.3 (above the 5.2 line) emerges on the radar", emerges("mythos 5.3 evals leaked", "claude-mythos-5-3"));
  check("fable 5.2 (AT the line, registered) does NOT emerge", ids("written for fable 5.2").length === 0);
  check("mythos 5.2 (AT the line, registered) does NOT emerge", ids("mythos 5.2 everywhere").length === 0);
  check("fable 5.2 gate-qualifies at 45 (Mythos tier tops the ladder)", qualWeight("claude-fable-5-2 pin", "claude-fable-5-2") === 45);
  check("mythos 5.2 gate-qualifies at 45", qualWeight("claude-mythos-5-2 pin", "claude-mythos-5-2") === 45);
  check("fable 5.1 gate-qualifies at 44", qualWeight("claude-fable-5-1 pin", "claude-fable-5-1") === 44);
  check("fable 4.9 (below the Mythos v5 floor) is gate-fiction", fictionIn("claude-fable-4-9 pin"));
  check("fable bare alias resolves to the family frontier model", detectModelFieldValue("fable")?.id === "claude-fable-5-2");
  check("fictionOnly flag fires on pure-fiction text", detectClaudeModels("claude-fable-5-3 and claude-opus-5-6 pins").fictionOnly === true);
}

// ============================================================
// 5. Prose immunity — the poetry and wine attacks
// ============================================================
{
  check("Shakespeare Sonnet 18: no signal", ids("Shakespeare Sonnet 18 analysis").length === 0);
  check("Sonnet 55 by Shakespeare: no signal (maj>9 guard)", ids("Sonnet 55 by Shakespeare").length === 0);
  check("Basho haiku 17: no signal (maj>9 guard)", ids("haiku 17 by Basho").length === 0);
  check("5-7-5 haiku structure: no signal (wrong order)", ids("the 5-7-5 haiku structure").length === 0);
  check("magnum opus 8 chapters: no signal (major-only guard)", ids("his magnum opus 8 chapters long").length === 0);
  check("opus dei 5 members: no signal", ids("opus dei 5 members attended").length === 0);
  check("opus 4.10 double-digit minor: no signal (min guard)", ids("opus 4.10 build notes").length === 0);
  // accepted risk, same doctrine as claude-utils-9-9: X.Y prose CAN look like a pin —
  // the authority gate is the backstop: unconfirmed signals steer nothing, ever.
  // (5.5 prose is now the AT-line version — no signal; the live risk is 5.6 prose.)
  check("AT-line prose 'magnum opus 5.5 rating': no signal", ids("magnum opus 5.5 out of 10").length === 0);
  check("ACCEPTED RISK: 'magnum opus 5.6 rating' emits a raw signal (authority gate backstops)", ids("magnum opus 5.6 out of 10").length === 1);
}

// ============================================================
// 6. Cross-family and mixed-text coherence
// ============================================================
{
  const both = ids("supports opus 5.6 and sonnet 5.6 tiers");
  check("mixed text: opus 5.6 AND sonnet 5.6 both emerge", both.includes("claude-opus-5-6") && both.includes("claude-sonnet-5-6"), both.join(","));
  const triple = ids("pins: claude-opus-5-6, claude-sonnet-5-6, claude-haiku-5-6");
  check("triple-family wave all emerge", triple.length === 3, triple.join(","));
  const mixed = detectClaudeModels("opus 5.5 with sonnet 5.6 leaks");
  check("gate: mixed real+future → qualifying AND fiction, no blockedOnly", mixed.qualifying.length > 0 && mixed.fiction.length > 0 && !mixed.blockedOnly);
  const oldOnly = detectClaudeModels("claude 2 with claude-2-1 fallback");
  check("gate: ancient-only text → blockedOnly", oldOnly.blockedOnly === true);
  const realOnly = detectClaudeModels("opus 5.5 with sonnet 5.5 fallback");
  check("gate: real-models text → qualifying, no contamination flags", realOnly.qualifying.length === 2 && realOnly.fiction.length === 0 && realOnly.blocked.length === 0);
}

// ============================================================
// 7. Wave generation parameterizes the new families correctly
// ============================================================
{
  const wave = waveQueriesFor({ id: "claude-sonnet-5-6", label: "Sonnet 5.6", version: 5.6 });
  check("sonnet wave has 7 patterns", wave.length === 7, String(wave.length));
  check("sonnet wave carries the version string", wave.every((w) => w.q.includes("5-6") || w.q.includes("5.6") || w.q.includes("5 6")));
  check("sonnet wave carries the family", wave.some((w) => w.q.toLowerCase().includes("sonnet")));
  check("sonnet wave anchors the router comparison to the REAL frontier (opus 5.5)", wave.some((w) => w.q.includes('"claude-opus-5-5"')));
  const hw = waveQueriesFor({ id: "claude-haiku-5-6", label: "Haiku 5.6", version: 5.6 });
  check("haiku wave has 7 patterns", hw.length === 7);
}

// ============================================================
// 8. Iron-rule API surface
// ============================================================
{
  check("isBlockedModelString('sonnet 5.5') = false (REAL model)", isBlockedModelString("sonnet 5.5") === false);
  check("isBlockedModelString('haiku 5.5') = false (REAL model)", isBlockedModelString("haiku 5.5") === false);
  check("isBlockedModelString('claude-fable-5-2') = false (REAL Mythos-tier model)", isBlockedModelString("claude-fable-5-2") === false);
  check("isBlockedModelString('claude-mythos-5-2') = false (REAL Mythos-tier model)", isBlockedModelString("claude-mythos-5-2") === false);
  check("isBlockedModelString('opus 5.6') = true (above the real line — fiction for the gate)", isBlockedModelString("opus 5.6") === true);
  check("isBlockedModelString('sonnet 5.6') = true (above the real line)", isBlockedModelString("sonnet 5.6") === true);
  check("isBlockedModelString('claude-opus-5') = true (real but below the 5.5 threshold)", isBlockedModelString("claude-opus-5") === true);
  check("bare 'opus 5' (prose form, no prefix/minor) is not even detected — prose guard", isBlockedModelString("opus 5") === false);
}

console.log(`\n${pass} pass / ${fail} fail — frontier-families (real lines: opus/sonnet/haiku 5.5, fable/mythos 5.2)`);
process.exit(fail > 0 ? 1 : 0);
