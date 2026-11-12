// test-frontier-families.ts — adversarial validation of frontier detection for
// the opus / sonnet / haiku families (the round that found 4 gaps on fable,
// now applied to every remaining frontier line).
//
// Frontier lines under test (familyFrontier):
//   opus   → 7    (registered: 5.5, 5.6, 6, 6.5, 7)
//   sonnet → 5.5  (no registered entry — line defaults to the iron threshold)
//   haiku  → 5.5  (no registered entry — line defaults to the iron threshold)
//
// The property under attack, per family:
//   1. EMERGING radar: a pin ABOVE the family line emerges in every real-world
//      phrasing (hyphen/space/underscore/comma/compact/date-suffix); a pin AT
//      or BELOW the line never does.
//   2. GATE agreement: above 5.5 the same pin is qualifying with the family
//      weight cap (sonnet 32 / haiku 24 / opus 45); below 5.5 it is blocked —
//      the radar and the gate can never disagree about the iron threshold.
//   3. Prose immunity: Shakespeare sonnets, Basho haiku, syllable counts and
//      magnum-opus chapters never create a frontier signal.
import {
  detectClaudeModels,
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
const blockedIn = (text: string, id: string) =>
  detectClaudeModels(text).blocked.some((b) => b.id === id);

// ============================================================
// 1. OPUS — line 7: the strongest family's frontier edge
// ============================================================
{
  // every real-world phrasing of the NEXT opus (7.1) must emerge
  check("opus 7.1 bare X.Y emerges", emerges("benchmarked against opus 7.1 last night", "claude-opus-7-1"));
  check("claude-opus-7-1 pin emerges", emerges('"model": "claude-opus-7-1"', "claude-opus-7-1"));
  check("opus 7,1 comma decimal emerges", emerges("tuned for opus 7,1 in production", "claude-opus-7-1"));
  check("claude_opus_7_1 underscore emerges", emerges("claude_opus_7_1 settings key", "claude-opus-7-1"));
  check("opus7.1 compact form emerges", emerges("upgrade to opus7.1 today", "claude-opus-7-1"));
  check("claude-opus-7-1-20260101 date suffix emerges", emerges("claude-opus-7-1-20260101 snapshot pin", "claude-opus-7-1"));
  check("claude-opus-8 major-only (prefixed) emerges", emerges("claude-opus-8 just launched", "claude-opus-8"));
  check("opus 8.1 two versions up emerges", emerges("opus 8.1 benchmarks leaked", "claude-opus-8-1"));

  // at-or-below the line: never emerging
  check("opus 6.9 (below line) does NOT emerge", ids("opus 6.9 comparison").length === 0);
  check("claude-opus-7-0 (= line) does NOT emerge", ids("claude-opus-7-0 release").length === 0);
  check("claude-opus-7 (registered) does NOT emerge", ids("claude-opus-7 is current").length === 0);
  check("opus 5.5 (registered) does NOT emerge", ids("opus 5.5 everywhere").length === 0);
  check("bare 'opus 8' (no prefix, no minor) does NOT emerge", ids("opus 8").length === 0);

  // gate agreement for opus
  check("opus 7.1 gate-qualifies at weight 45", qualWeight("opus 7.1 pin", "claude-opus-7-1") === 45);
  check("opus 6.9 gate-qualifies (≥6.5, weight 45)", qualWeight("opus 6.9 pin", "claude-opus-6-9") === 45);
  check("opus 4.5 gate-blocked", blockedIn("claude-opus-4-5-20251101", "claude-opus-4-5"));
}

// ============================================================
// 2. SONNET — line 5.5 (threshold-default family): the next sonnet release
// ============================================================
{
  check("sonnet 5.6 bare X.Y emerges", emerges("written for sonnet 5.6, fast and cheap", "claude-sonnet-5-6"));
  check("claude-sonnet-5-6 pin emerges", emerges('"model": "claude-sonnet-5-6"', "claude-sonnet-5-6"));
  check("sonnet-5-6 hyphenated bare emerges", emerges("router defaults to sonnet-5-6", "claude-sonnet-5-6"));
  check("claude-sonnet-6 major-only (prefixed) emerges", emerges("claude-sonnet-6 announced", "claude-sonnet-6"));
  check("sonnet 6.2 two notches up emerges", emerges("sonnet 6.2 eval results", "claude-sonnet-6-2"));

  check("sonnet 5.5 (AT the line) does NOT emerge", ids("sonnet 5.5 is current").length === 0);
  check("claude-sonnet-5-5 does NOT emerge", ids('"claude-sonnet-5-5"').length === 0);
  check("sonnet 4.5 (old) does NOT emerge", ids("sonnet 4.5 fallback").length === 0);
  check("claude-3-5-sonnet (legacy format) does NOT emerge", ids("claude-3-5-sonnet-20241022").length === 0);
  check("bare 'sonnet 6' (no prefix, no minor) does NOT emerge", ids("sonnet 6").length === 0);
  check("sonnet 5.4 (below iron threshold) does NOT emerge", ids("sonnet 5.4 leak").length === 0);

  // gate agreement for sonnet
  check("sonnet 5.6 gate-qualifies with cap 32", qualWeight("sonnet 5.6 pin", "claude-sonnet-5-6") === 32);
  check("sonnet 4.5 gate-blocked", blockedIn("sonnet 4.5", "claude-sonnet-4-5"));
}

// ============================================================
// 3. HAIKU — line 5.5 (threshold-default family)
// ============================================================
{
  check("haiku 5.6 bare X.Y emerges", emerges("cheap tier runs haiku 5.6", "claude-haiku-5-6"));
  check("claude-haiku-5-6 pin emerges", emerges('"model": "claude-haiku-5-6"', "claude-haiku-5-6"));
  check("claude-haiku-6 major-only (prefixed) emerges", emerges("claude-haiku-6 released", "claude-haiku-6"));

  check("haiku 5.5 (AT the line) does NOT emerge", ids("haiku 5.5 current").length === 0);
  check("claude-haiku-5-5 does NOT emerge", ids('"claude-haiku-5-5"').length === 0);
  check("haiku 4.5 (old) does NOT emerge", ids("haiku 4.5 fallback").length === 0);
  check("bare 'haiku 5' (syllables, no minor) does NOT emerge", ids("haiku 5 syllables per line").length === 0);

  // gate agreement for haiku
  check("haiku 5.6 gate-qualifies with cap 24", qualWeight("haiku 5.6 pin", "claude-haiku-5-6") === 24);
  check("haiku 4.5 gate-blocked", blockedIn("haiku-4-5", "claude-haiku-4-5"));
}

// ============================================================
// 4. Prose immunity — the poetry and wine attacks
// ============================================================
{
  check("Shakespeare Sonnet 18: no signal", ids("Shakespeare Sonnet 18 analysis").length === 0);
  check("Sonnet 55 by Shakespeare: no signal (maj>9 guard)", ids("Sonnet 55 by Shakespeare").length === 0);
  check("Basho haiku 17: no signal (maj>9 guard)", ids("haiku 17 by Basho").length === 0);
  check("5-7-5 haiku structure: no signal (wrong order)", ids("the 5-7-5 haiku structure").length === 0);
  check("magnum opus 8 chapters: no signal (major-only guard)", ids("his magnum opus 8 chapters long").length === 0);
  check("opus dei 5 members: no signal", ids("opus dei 5 members attended").length === 0);
  check("opus 7.10 double-digit minor: no signal (min guard)", ids("opus 7.10 build notes").length === 0);
  // accepted risk, same doctrine as claude-utils-9-9: X.Y prose CAN look like a pin —
  // the ≥2-repo confirmation gate is the backstop, single-repo noise never steers.
  check("ACCEPTED RISK: 'magnum opus 8.5 rating' emits a raw signal (confirmation gate backstops)", ids("magnum opus 8.5 out of 10").length === 1);
}

// ============================================================
// 5. Cross-family and mixed-text coherence
// ============================================================
{
  const both = ids("supports opus 7.1 and sonnet 5.6 tiers");
  check("mixed text: opus 7.1 AND sonnet 5.6 both emerge", both.includes("claude-opus-7-1") && both.includes("claude-sonnet-5-6"), both.join(","));
  const triple = ids("pins: claude-opus-7-1, claude-sonnet-5-6, claude-haiku-5-6");
  check("triple-family wave all emerge", triple.length === 3, triple.join(","));
  const mixed = detectClaudeModels("opus 7.1 with sonnet 4.5 fallback");
  check("gate: mixed new+old → qualifying AND blocked, not blockedOnly", mixed.qualifying.length > 0 && mixed.blocked.length > 0 && !mixed.blockedOnly);
  const oldOnly = detectClaudeModels("sonnet 4.5 with haiku 4.5 fallback");
  check("gate: old-only text → blockedOnly", oldOnly.blockedOnly === true);
}

// ============================================================
// 6. Wave generation parameterizes the new families correctly
// ============================================================
{
  const wave = waveQueriesFor({ id: "claude-sonnet-5-6", label: "Sonnet 5.6", version: 5.6 });
  check("sonnet wave has 7 patterns", wave.length === 7, String(wave.length));
  check("sonnet wave carries the version string", wave.every((w) => w.q.includes("5-6") || w.q.includes("5.6") || w.q.includes("5 6")));
  check("sonnet wave carries the family", wave.some((w) => w.q.toLowerCase().includes("sonnet")));
  const hw = waveQueriesFor({ id: "claude-haiku-5-6", label: "Haiku 5.6", version: 5.6 });
  check("haiku wave has 7 patterns", hw.length === 7);
}

// ============================================================
// 7. Iron-rule API surface
// ============================================================
{
  check("isBlockedModelString('sonnet 4.5') = true", isBlockedModelString("sonnet 4.5") === true);
  check("isBlockedModelString('haiku 4.5') = true", isBlockedModelString("haiku 4.5") === true);
  check("isBlockedModelString('opus 7.1') = false", isBlockedModelString("opus 7.1") === false);
  check("isBlockedModelString('sonnet 5.6') = false", isBlockedModelString("sonnet 5.6") === false);
}

console.log(`\n${pass} pass / ${fail} fail — frontier-families (opus/sonnet/haiku)`);
process.exit(fail > 0 ? 1 : 0);
