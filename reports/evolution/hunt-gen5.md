# Live Hunt — Generation 5 (reconstructed post-hoc from DB evidence)

*Report written late: Gen 5 ran between the round-1 audit and Gen 6 and never got its own report.
This document is built **exclusively** from `LiveHunt` row #5 + `Mission` row #9 stage evidence —
nothing from memory, nothing from prior chat claims.*

## Run facts (DB: liveHunt id=5)

- Generation 5, seeded from hunt #4 · 8/8 stages · 364s elapsed
- DNA: **126 → 129** (baseline was 131 before the round-1 audit purged 5 stub genes)
- Mission #9 `m365-bridge-due-diligence` — 4 phases, all executed, 0 failures

## Stage log (evidence fields, verbatim semantics)

```
hunt     24 queries (10 evolved, origin evolved:gen5) · 935 candidates · 935 hard-evidence
         · 0 repo-search hits · novelty (allNames memory, first honest run): 913 new / 2% repeat
         ⚠ retro-found in round 2: all 10 evolved queries targeted repo:anthropic-ai/claude
           (nonexistent repo) and returned 0 hits — counted in the 24 but contributed nothing.
           The deterministic gate that now blocks this was built AFTER this run (Gen 6 first used it).
swarm    12 judged · 6 elite · 5 watch · 1 noise · 6 profiles · 6 auto-saved · 2 LLM calls
attack   5 patterns · 3 top-moves · 12 next-gen queries (all dead repo:anthropic-ai/claude —
         every one of them blocked by the Gen-6 gate) · 4 LLM calls
mine     3 repos mined (simonw/llm-anthropic 0 artifacts, KilimcininKorOglu/M365Bridge 0,
         Round-Tower/M1K3 +2 genes) · 2 DNA added · 0 stubs
compile  mission #9 · 8 genes ranked by goal-match (deterministic token scoring) ·
         SKILL.md source: **fallback** (2,865 bytes — local template, honestly labeled)
execute  4/4 phases · deliverables 4,903 + 5,785 chars
grow     AI distill · 5 lessons · DNA #141 born (field:livehunt-5, due-diligence-framework)
verdict  API↔DB match: dna 129 · missions 9 · llmCalls 13 (lower-bound; see audit-round2 §4)
```

## Honest scorecard for this generation

| Worked | Didn't |
|---|---|
| First honest novelty metric (full `allNames` memory): 913/2% is a real measurement | Evolved queries were 100% hallucinated repo targets — "evolution" contributed zero coverage |
| First real comparative triage ({6,5,1} spread, not 12/12 rubber-stamp) | Mission SKILL.md was a fallback template |
| +3 real genes; 0 stubs | 2 of 3 mined repos yielded nothing (re-mining already known-empty — fixed in round 2) |
| Mission executed 4/4 with real LLM deliverables | `llmCalls` figure is a formula-based lower bound |
