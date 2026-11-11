---
name: verified-mutation-flywheel
description: Operating system for change under adversarial verification — standing desks, staged drafts, measured gates, and a history that compounds into sharper skepticism.
---

# Verified Mutation Flywheel

## Overview
Nothing enters, mutates, or ships without passing a standing desk, a staged draft, and a measured gate. Every verdict is recorded, and the record makes the next red-team sharper. Verification is not a tax — it is compounding capital.

## Activation Triggers
Use when:
- Any change is about to enter a production surface (library, API, dataset)
- A recurring check is being scheduled as a one-off event (make it a standing desk instead)
- A thesis, candidate or target is about to be accepted on vibes
- Designing acceptance gates for new work
- Reviewing whether a past verdict's evidence still holds

## The Five Principles

1. **Data before doctrine.** Before any analysis: fetch live state — never assume from training data. Every figure carries source, as-of date and confidence at the top of the output. Stale data is flagged loudly, never silently used.
2. **Standing desks, silent roles.** Verification is a persistent standing window over a queue, not a scheduled event. Slots refill on completion; reviews run in parallel; everything is reviewed within one cadence tick. Human-needed items are filed artifacts, never narration. Humans merge — always.
3. **Draft → Validate → Publish.** Every mutation is a staged draft. Batch validation catches all errors across the whole hierarchy before anything goes live. Undo is cheap because nothing live exists yet. Publishing requires explicit confirmation.
4. **Six gates, one ratchet.** Types, lint, tests, coverage (≥80%), security, dead code — stack-agnostic, stack detected before running. The measurement harness is read BEFORE authoring. Regression net: quality only moves up, never below last-green.
5. **Adversarial pass before belief.** Before accepting any thesis, candidate or change, run the deliberate red-team arguing the exact opposite. Counterevidence is a first-class output. Belief is earned by surviving your own bear case.

## Workflow

### Phase 1 — Pre-flight data oath (WO1)
```
for every figure the decision depends on:
  fetch live → record {value, source, asOf, confidence}
  if stale or unavailable → render ⚠️ warning BEFORE proceeding
```

### Phase 2 — Stage the mutation (WO3)
```
mutation → draft (nothing live)
batch-validate the FULL hierarchy in one pass
on error → fix in draft space (undo = delete draft)
on green → request explicit publish confirmation
```

### Phase 3 — Standing review window (WO2)
```
desk opens over the queue (intake → work → review → human-merge)
while queue non-empty:
  refill reviewer slots as they complete
  review in parallel
  everything reviewed within one cadence tick
file human-needed items as artifacts; run silent
```

### Phase 4 — Gate on measurement (WO4)
```
read the harness BEFORE authoring
define acceptance gates up-front
null-test against a reference
ratchet: this run may not fall below last-green
```

### Phase 5 — Record the verdict (WO5)
```
every accept/reject → change-history {what, evidence, verdict, when}
history is not an audit log — it is base-rate ammunition
```

## The Breakthrough
Most systems pay verification as a fixed tax per change. The flywheel converts it into capital: each recorded verdict accumulates base rates, and base rates are exactly what the next adversarial pass needs. Skepticism compounds — measure → stage → red-team → gate → record → measure better. A system that verifies this way isn't just safer; its judgment compounds while rivals' stays flat.

## Anti-Patterns
- Accepting a candidate because "it looks good" — run the bear case first
- Scheduling verification as a one-off meeting — open a standing desk
- Validating item-by-item — batch-validate the hierarchy
- Deleting old green results — they are the ratchet's floor
- Console-narrating human decisions — file them as artifacts

## Provenance
Cross-pollinated from the richest fresh DNA in the gen-22 library (826 genes): yennanliu/InvestSkill (Bear Case), medici-finance/assay (pr-review-desk), spotify/ads-agentic-tools (build-campaign), itz4blitz/agentful (validation), Generous-Corp/pulp (audio-harness). Chimera #3 of Claude Hunter Pro, 2026-11-11.
