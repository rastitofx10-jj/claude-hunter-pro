// test-frontier-families.ts — adversarial validation of frontier detection for
// the opus / sonnet / haiku families against the REAL registry lines.
//
// Real frontier lines under test (familyFrontier from the real registry):
//   opus   → 4.5   (registered: 4.5, 4.1, 4, 3)
//   sonnet → 4.5   (registered: 4.5, 4, 3.7, 3.5, 3)
//   haiku  → 4.5   (registered: 4.5, 3.5, 3)
//
// The property under attack, per family:
//   1. RADAR: a pin ABOVE the real line (4.6, 5, ...) emerges in every
//      real-world phrasing; a pin AT or BELOW the line never does.
//   2. GATE agreement: real models get the real ladder weights (opus 4.5 = 45,
//      sonnet 4.5 = 34, haiku 4.5 = 26); pins above the line are FICTION for
//      the gate (weight 0, contamination flag) — only the authority-gated
//      radar may promote a real future release.
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
// 1. OPUS — real line 4.5: the strongest real model's edge
// ============================================================
{
  // every real-world phrasing of the NEXT opus (4.6) must emerge
  check("opus 4.6 bare X.Y emerges", emerges("benchmarked against opus 4.6 last night", "claude-opus-4-6"));
  check("claude-opus-4-6 pin emerges", emerges('"model": "claude-opus-4-6"', "claude-opus-4-6"));
  check("opus 4,6 comma decimal emerges", emerges("tuned for opus 4,6 in production", "claude-opus-4-6"));
  check("claude_opus_4_6 underscore emerges", emerges("claude_opus_4_6 settings key", "claude-opus-4-6"));
  check("opus4.6 compact form emerges", emerges("upgrade to opus4.6 today", "claude-opus-4-6"));
  check("claude-opus-4-6-20260101 date suffix emerges", emerges("claude-opus-4-6-20260101 snapshot pin", "claude-opus-4-6"));
  check("claude-opus-5 major-only (prefixed) emerges", emerges("claude-opus-5 just launched", "claude-opus-5"));
  check("opus 5.1 two notches up emerges", emerges("opus 5.1 benchmarks leaked", "claude-opus-5-1"));

  // at-or-below the real line: never emerging
  check("opus 4.4 (below line) does NOT emerge", ids("opus 4.4 comparison").length === 0);
  check("claude-opus-4-5 (= the real line) does NOT emerge", ids("claude-opus-4-5 release").length === 0);
  check("opus 4.1 (registered) does NOT emerge", ids("opus 4.1 is current").length === 0);
  check("bare 'opus 5' (no prefix, no minor) does NOT emerge", ids("opus 5").length === 0);

  // gate agreement for opus
  check("opus 4.5 gate-qualifies at weight 45 (the strongest real model)", qualWeight("opus 4.5 pin", "claude-opus-4-5") === 45);
  check("opus 4.1 gate-qualifies at weight 30", qualWeight("claude-opus-4-1 pin", "claude-opus-4-1") === 30);
  check("opus 4.6 gate-fiction (above the real line — radar's job)", fictionIn("opus 4.6 pin"));
  check("opus 5 gate-fiction", fictionIn("claude-opus-5 is out"));
  check("opus 4.5 gate-real (no fiction flag)", !fictionIn("claude-opus-4-5 everywhere"));
}

// ============================================================
// 2. SONNET — real line 4.5
// ============================================================
{
  check("sonnet 4.6 bare X.Y emerges", emerges("written for sonnet 4.6, fast and cheap", "claude-sonnet-4-6"));
  check("claude-sonnet-4-6 pin emerges", emerges('"model": "claude-sonnet-4-6"', "claude-sonnet-4-6"));
  check("sonnet-4-6 hyphenated bare emerges", emerges("router defaults to sonnet-4-6", "claude-sonnet-4-6"));
  check("claude-sonnet-5 major-only (prefixed) emerges", emerges("claude-sonnet-5 announced", "claude-sonnet-5"));
  check("sonnet 5.2 two notches up emerges", emerges("sonnet 5.2 eval results", "claude-sonnet-5-2"));

  check("sonnet 4.5 (AT the real line) does NOT emerge", ids("sonnet 4.5 is current").length === 0);
  check("claude-sonnet-4-5 does NOT emerge", ids('"claude-sonnet-4-5"').length === 0);
  check("sonnet 4 (registered) does NOT emerge", ids("claude-sonnet-4 fallback").length === 0);
  check("claude-3-5-sonnet (legacy real format) does NOT emerge", ids("claude-3-5-sonnet-20241022").length === 0);
  check("bare 'sonnet 5' (no prefix, no minor) does NOT emerge", ids("sonnet 5").length === 0);
  check("sonnet 4.4 (below line) does NOT emerge", ids("sonnet 4.4 leak").length === 0);

  // gate agreement for sonnet
  check("sonnet 4.5 gate-qualifies at 34 (real ladder)", qualWeight("sonnet 4.5 pin", "claude-sonnet-4-5") === 34);
  check("sonnet 4 gate-qualifies at 24", qualWeight("claude-sonnet-4 pin", "claude-sonnet-4") === 24);
  check("sonnet 4.6 gate-fiction (above line)", fictionIn("sonnet 4.6 pin"));
  check("sonnet 3.5 gate-real at 14 (3.x-era id format)", qualWeight("claude-3-5-sonnet-20241022 pin", "claude-3-5-sonnet") === 14);
}

// ============================================================
// 3. HAIKU — real line 4.5
// ============================================================
{
  check("haiku 4.6 bare X.Y emerges", emerges("cheap tier runs haiku 4.6", "claude-haiku-4-6"));
  check("claude-haiku-4-6 pin emerges", emerges('"model": "claude-haiku-4-6"', "claude-haiku-4-6"));
  check("claude-haiku-5 major-only (prefixed) emerges", emerges("claude-haiku-5 released", "claude-haiku-5"));

  check("haiku 4.5 (AT the real line) does NOT emerge", ids("haiku 4.5 current").length === 0);
  check("claude-haiku-4-5 does NOT emerge", ids('"claude-haiku-4-5"').length === 0);
  check("haiku 3.5 (registered) does NOT emerge", ids("claude-3-5-haiku fallback").length === 0);
  check("bare 'haiku 5' (syllables, no minor) does NOT emerge", ids("haiku 5 syllables per line").length === 0);

  // gate agreement for haiku
  check("haiku 4.5 gate-qualifies at 26 (real ladder)", qualWeight("haiku 4.5 pin", "claude-haiku-4-5") === 26);
  check("haiku 4.6 gate-fiction (above line)", fictionIn("haiku 4.6 pin"));
}

// ============================================================
// 4. FICTION family — fable never gets any credit, any signal, any filter
// ============================================================
{
  check("fable 5.5 (the old 'confirmed wave') is gate-FICTION", fictionIn("claude-fable-5-5 pins"));
  check("fable 5.5 never emerges on the radar", ids("claude-fable-5-5 everywhere").length === 0);
  check("fable 5.2 never emerges", ids("written for fable 5.2").length === 0);
  check("fable settings pin → no model field value", detectModelFieldValue("fable") === null);
  check("fable filter is blocked (no quota for hallucinations)", isBlockedModelString("fable") === true);
  check("fictionOnly flag fires on pure-fiction text", detectClaudeModels("claude-fable-5-2 and claude-opus-5-5 pins").fictionOnly === true);
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
  check("ACCEPTED RISK: 'magnum opus 5.5 rating' emits a raw signal (authority gate backstops)", ids("magnum opus 5.5 out of 10").length === 1);
}

// ============================================================
// 6. Cross-family and mixed-text coherence
// ============================================================
{
  const both = ids("supports opus 4.6 and sonnet 4.6 tiers");
  check("mixed text: opus 4.6 AND sonnet 4.6 both emerge", both.includes("claude-opus-4-6") && both.includes("claude-sonnet-4-6"), both.join(","));
  const triple = ids("pins: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-6");
  check("triple-family wave all emerge", triple.length === 3, triple.join(","));
  const mixed = detectClaudeModels("opus 4.5 with sonnet 4.6 leaks");
  check("gate: mixed real+future → qualifying AND fiction, no blockedOnly", mixed.qualifying.length > 0 && mixed.fiction.length > 0 && !mixed.blockedOnly);
  const oldOnly = detectClaudeModels("claude 2 with claude-2-1 fallback");
  check("gate: ancient-only text → blockedOnly", oldOnly.blockedOnly === true);
  const realOnly = detectClaudeModels("opus 4.5 with sonnet 4.5 fallback");
  check("gate: real-models text → qualifying, no contamination flags", realOnly.qualifying.length === 2 && realOnly.fiction.length === 0 && realOnly.blocked.length === 0);
}

// ============================================================
// 7. Wave generation parameterizes the new families correctly
// ============================================================
{
  const wave = waveQueriesFor({ id: "claude-sonnet-4-6", label: "Sonnet 4.6", version: 4.6 });
  check("sonnet wave has 7 patterns", wave.length === 7, String(wave.length));
  check("sonnet wave carries the version string", wave.every((w) => w.q.includes("4-6") || w.q.includes("4.6") || w.q.includes("4 6")));
  check("sonnet wave carries the family", wave.some((w) => w.q.toLowerCase().includes("sonnet")));
  check("sonnet wave anchors the router comparison to the REAL frontier (opus 4.5)", wave.some((w) => w.q.includes('"claude-opus-4-5"')));
  const hw = waveQueriesFor({ id: "claude-haiku-4-6", label: "Haiku 4.6", version: 4.6 });
  check("haiku wave has 7 patterns", hw.length === 7);
}

// ============================================================
// 8. Iron-rule API surface
// ============================================================
{
  check("isBlockedModelString('sonnet 4.5') = false (REAL model)", isBlockedModelString("sonnet 4.5") === false);
  check("isBlockedModelString('haiku 4.5') = false (REAL model)", isBlockedModelString("haiku 4.5") === false);
  check("isBlockedModelString('opus 4.6') = true (above the real line — fiction for the gate)", isBlockedModelString("opus 4.6") === true);
  check("isBlockedModelString('sonnet 4.6') = true (above the real line)", isBlockedModelString("sonnet 4.6") === true);
  check("isBlockedModelString('claude-fable-5-2') = true (fiction)", isBlockedModelString("claude-fable-5-2") === true);
}

console.log(`\n${pass} pass / ${fail} fail — frontier-families (real lines: opus/sonnet/haiku 4.5)`);
process.exit(fail > 0 ? 1 : 0);
