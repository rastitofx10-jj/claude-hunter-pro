# Chimera #3 — verified-mutation-flywheel

**Born:** 2026-11-11 · gen 22 library (826 genes, 163 repos)
**Parents (all fresh — none used in chimeras #1/#2):**

| Parent | Contributed gene |
|---|---|
| `yennanliu/InvestSkill` | Bear Case (Bearish Investor) — deliberate red-team, data verification before any analysis |
| `medici-finance/assay` | pr-review-desk — standing review window, silent roles, human merges |
| `spotify/ads-agentic-tools` | build-campaign — draft → validate → publish, batch validation, easy undo |
| `itz4blitz/agentful` | validation — 6 core quality gates, stack detection, 80% coverage floor |
| `Generous-Corp/pulp` | audio-harness — measurement surface read BEFORE authoring, regression ratchet |

**One-liner:** An operating system for change under adversarial verification — nothing enters, mutates, or ships without passing a standing desk, a staged draft, and a measured gate; and every verdict recorded makes the next red-team sharper.

---

## The five principles (each mined verbatim from parent DNA)

1. **Data before doctrine** *(InvestSkill)* — Before ANY analysis: fetch live state, never assume from training data. Every figure carries its source, as-of date and confidence at the top of the output. Stale data is flagged loudly, never silently used.
2. **Standing desks, silent roles** *(assay)* — Verification is a persistent standing window watching a queue, not an event you schedule. Reviewer slots refill on completion; reviews run in parallel; every item is reviewed within one cadence tick. Anything needing a human is a filed artifact, never console narration. Humans merge — always.
3. **Draft → Validate → Publish** *(Spotify)* — Every mutation is staged as a draft first. Batch validation catches all errors across the entire hierarchy before anything goes live. Undo is cheap because nothing live exists yet. Publishing requires explicit confirmation.
4. **Six gates, one ratchet** *(agentful + pulp)* — Types, lint, tests, coverage (≥80%), security, dead code — stack-agnostic, detected before running. The measurement harness is read BEFORE authoring, not only when something already sounds wrong. Regression net: quality only moves up, never below last-green.
5. **Adversarial pass before belief** *(InvestSkill Bear Case)* — Before accepting any thesis, candidate or change, run the deliberate red-team that argues the exact opposite. Counterevidence is a first-class output, not an appendix. An idea that survives its own bear case earns belief.

## Work orders (how to operate it)

- **WO1 — The pre-flight data oath.** No analysis or mutation begins on assumed state. Fetch live; stamp source + as-of + confidence on every figure; render staleness warnings before proceeding.
- **WO2 — Open the standing window.** Convert every recurring verification from an event into a standing desk over its queue: intake → work → review → human merge. Keep the slot pool full, review in parallel, measure in cadence ticks.
- **WO3 — Stage every mutation.** All changes are drafts. Batch-validate the full hierarchy (not item-by-item), publish only on explicit confirmation, delete-draft is the undo path.
- **WO4 — Gate on measurement, ratchet on green.** Acceptance gates are defined BEFORE work begins, read from the harness. Compare against a reference (null test). Once green, the ratchet holds: the next run may not fall below it.
- **WO5 — Record every verdict.** Every accept/reject with its evidence goes to change-history. The history is not an audit log — it is training data for the next adversarial pass.

## The breakthrough: verification compounds

Most systems treat verification as a **tax** — a fixed cost paid per change, forever. The flywheel turns it into **capital**: each recorded verdict accumulates base rates ("8-quarter beat rate", rejection patterns, gate statistics), and those base rates are exactly the ammunition the next bear-case red-team needs. So skepticism gets *sharper every cycle* instead of staying constant — measure → stage → red-team → gate → record → measure better. A system that verifies this way is not just safer than its rivals; it is *more dangerous*, because its judgment compounds while theirs stays flat.

## Injection into Claude Hunter Pro (live-code targets)

- **WO1** → snapshot & radar already stamp `exportedAt`; next: as-of dates per gene source
- **WO2** → the sweep already runs as a standing cadence; pr-review-desk pattern fits the sweep findings queue
- **WO3** → chimera generation should stage a draft chimera for review before committing to the library
- **WO4** → the chimera-2 quality gate (sweep surface) is the ratchet's first tooth
- **WO5** → change-history timeline of library mutations (the Spotify change-history gene, live)
