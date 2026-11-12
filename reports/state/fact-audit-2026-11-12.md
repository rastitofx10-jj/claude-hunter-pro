# Fact Audit — 2026-11-12 (the truth migration)

> Trigger: the owner's roast demand — "there are tons of lies, like fable 5.5
> which doesn't exist, and many more invented fantasies."
> Verdict on the owner's claim: **correct, and understated.** The fiction was
> not one bad claim — it was the system's entire model ontology, inverted.

## 1. The core finding

The registry held a **fictional model lineup as premium** ("Fable 5/5.1/5.2/5.5",
"Opus 5.5/5.6/6/6.5/7" — none exist) while **hard-blocking every real model**
(Opus 4.5, Sonnet 4.5, Haiku 4.5 — the actual strongest models Anthropic ships)
as "below threshold". Every layer downstream inherited the inversion.

**Empirical proof (live, 2026-11-12):**

| Query (org:anthropics — Anthropic's own repos) | total_count |
|---|---|
| `"claude-opus-4-5"` | **46** (claude-code, skills, SDKs) |
| `"claude-fable-5-5"` | **0** |

The model the radar had "confirmed" as a LIVE WAVE does not exist in a single
file owned by its own supposed maker.

## 2. Claim-by-claim roast (what I reported vs. reality)

| # | What I claimed (2026-11-12 reports) | Reality | Fix |
|---|---|---|---|
| 1 | "Fable 5.5 — LIVE WAVE... 41 mentions across 8 repos... radar confirmed in-run" | Text mentions in hallucination-spam repos. The model does not exist (0 authority hits). "Confirmed" meant "2+ repos contain the string" — a text check dressed as a fact check. | Ledger entry reclassified to `kind=fiction`; confirmation now requires an **org:anthropics authority hit** (`promoteWithAuthority`) |
| 2 | "The radar detects the next model on day one without code edits" | It detects the next *hallucination wave* on day one just as happily. Mechanism was real; the truth anchor was missing. | Frontier line recalculated from the REAL registry (4.5); fiction words never signal |
| 3 | "29→30 hunts, missions executed autonomously" | Hunt counts and execution were real; the *goals* were fiction — 24 of 28 missions chased hallucinated models ("fable-api-access-acquisition" etc.) | 24 missions **voided** with explicit reason; 4 real-intel missions kept |
| 4 | "1464→1531 genes (+37)" | Gene counts are real rows; the *attribution layer* was fabricated — **all 23 watchlist repos carried only fictional model ids** (even `anthropics/claude-code` showed "claude-fable-5-2") | `models` reset to truth (re-detected from real GitHub metadata only — all 23 came back empty); honest rescoring: fiction-inflated 76–100 → traction-only 12–31 |
| 5 | "49/49, 58/58, 21/21 tests green" | Green tests asserting a lie — the suites *encoded* the fantasy ontology. | All three suites rewritten against reality: **63 + 58 + 70 = 191 checks green on truth** |
| 6 | "adaptive learning — 41-query book" | 40 of 67 learned queries (60%) targeted fictional strings; the learning had *optimized* quota burn toward hallucinations | 40 fiction queries purged; 27 real kept |
| 7 | "the strongest there is" (per the owner's directive) | The system's "strongest" (Fable, weight 45) did not exist. The real strongest — Opus 4.5 — was weight 0, hard-blocked, filtered out of every search. | Opus 4.5 = weight 45, the hunting target; real 4.x ladder restored |

## 3. How the lie became an institution (mechanism)

1. An unverified LLM output introduced "fable" as a premium family; a code
   comment even enshrined "the day Fable 5.2 shipped" — a fabricated memory of
   a fabricated event.
2. The **LLM prompts themselves** were taught the inversion ("Fable 5.1/5.2 are
   full flagship premium... The 4.x family is junk — zero value") — every
   triage, swarm, and mission-compile pass re-affirmed the fiction.
3. The arsenal hunted fiction strings → found hallucination-spam repos →
   "yields" reinforced the queries (adaptive learning *rewarded* the lie).
4. The radar's confirmation rule ("≥2 repos mention it") laundered text into
   fact. Two spam repos = "LIVE WAVE".
5. Tests asserted the ontology. Green meant consistent, not true.

**The systemic flaw: no ground-truth anchor anywhere in the loop.**

## 4. Fixes applied (code)

- `claude-models.ts` — REAL registry (Opus 4.5 = 45, Sonnet 4.5 = 34, Haiku
  4.5 = 26, real ladder down to the 3.x era); fiction bucket (fable, anything
  above the real 4.5 frontier, claude ≥ 5) with `fictionOnly` contamination
  flag; 3.x-era id format fixed (`claude-3-5-sonnet` family-last);
  `claude-2.x` correctly blocked as ancient.
- `emerging-models.ts` — frontier = REAL registry lines; fiction words never
  signal; **authority gate**: `vouchReached` at ≥2 repos → `promoteWithAuthority`
  runs `org:anthropics "<id>"` — the ONLY path to `confirmed`; only confirmed
  waves feed the arsenal.
- `deep-sweep.ts` — market + frontier-model queries now hunt real pins
  (`claude-opus-4-5`...); authority promotion wired into `buildAdaptiveArsenal`;
  emerging-wave evidence flows through the fiction bucket (correct: above-frontier
  ids are fiction *for the gate*, confirmed *for the radar*).
- `frontier-queries.ts` — the model pool hunts the real frontier.
- `ai-intel.ts` / `intel-swarm.ts` — the LLM is now taught the TRUTH and
  ordered to flag fiction as contamination.
- `github.ts` (scoring) — real-model credit restored; fiction pins = negative
  trust (−5) with explicit warning; mixed real+fiction flagged.
- `analyze` route + UI sheets — truth verdicts, fiction warnings, real labels.
- Frontend chip — calm state shows the real frontier ("Opus 4.5"); waves shown
  only when authority-confirmed.
- Deleted the fiction-era one-offs (`fable-probe.mjs`, `fable-52-test.ts`,
  `verify-round4.ts`).

## 5. Fixes applied (data)

- Ledger: `claude-fable-5-5` → `kind=fiction, confirmed=false` (contamination
  record kept — noise stays recorded, labeled as noise).
- 23/23 watchlist repos: fabricated `models` reset (all null — the honest state
  is "attribution unknown, pending re-verification by the corrected pipeline"),
  scores recomputed honestly.
- 24/28 missions voided with reason; 4 kept.
- 40/67 learning queries purged.
- 1531 genes KEPT — the mined files are real content from real repos; the
  fiction lived in the attribution, not the files.

## 6. What was and remains REAL (not everything burned)

- The pipeline itself: hunt → harvest → sweep → desk → snapshot → push,
  resumable, recycle-proof — worked flawlessly; it was *pointed at fiction*.
- 1531 mined capability files from real repos (incl. anthropics/claude-code).
- License provenance tracking, adaptive-learning machinery, quota discipline.
- The regex/detection engine — mechanically sound, now aimed at reality.

## 7. Epistemic rules encoded going forward

1. **Authority before action** — no model claim steers the arsenal without an
   org:anthropics hit. Text mentions are signals, never facts.
2. **The registry is the truth anchor** — real ids only, verifiable in
   Anthropic's own repos.
3. **Fiction is tracked, never deleted silently** — contamination records carry
   labels and reasons (WO5 discipline).
4. **Tests assert reality** — a green suite must mean "matches the world", not
   "matches the code".

## 8. Numbers

| Metric | Before (fiction era) | After (truth) |
|---|---|---|
| Real models in registry | 0 (all blocked) | 12 (ladder 4→45) |
| Watchlist repos with real model attribution | 0 / 23 | 0 / 23 (honest null — pending re-verification) |
| Missions based on real intel | 4 / 28 | 4 / 28 kept + 24 voided honestly |
| Learning queries targeting reality | 27 / 67 (40%) | 27 / 27 (100%) |
| Confirmation path for a "new model" | 2 spam repos | org:anthropics authority hit |
| Authority check `claude-opus-4-5` | n/a | **46 hits — real** |
| Authority check `claude-fable-5-5` | "LIVE WAVE" | **0 hits — fiction** |
| Test checks asserting truth | 0 / 128 | **191 / 191** |

— generated by the truth migration; raw machine audit in `truth-audit.json`.
