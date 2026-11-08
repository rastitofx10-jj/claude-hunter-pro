# Live Hunt — Generation 3 (autonomous)

**Seed**: Gen 2 (10 inherited evolved queries) · **DNA before**: 110 → **after**: 129 (+19) · **Missions**: 7 total · **LLM calls**: 13 · **Wall time**: ~6 min · **Model gate**: 5.5+ only (fable included), zero tolerance ≤4.x

## Stage-by-stage evidence

| # | Stage | Time | Raw result |
|---|---|---|---|
| 1 | hunt | 196s | 24 queries · 935 ranked candidates (all with hard evidence) · **913 new beyond prior knowledge** · seeded 10 queries from hunt #2 |
| 2 | swarm | 39s | 12 judged · 12 elite · 0 watch · 12 profiles · 12 auto-saved |
| 3 | attack | 29s | 4 patterns · 3 moves · **10 next-gen queries spawned** (`origin:"evolved:gen3"`) |
| 4 | mine | 5s | 3 repos mined · **18 new genes into library** |
| 5 | compile | 34s | Mission #7 `api-fortress-dominance` · 3 steps · 8 genes selected · SKILL.md (fallback) |
| 6 | execute | 9s+14s | steps 1/3 → 3/3 completed autonomously |
| 7 | grow | 16s | AI distillation · 6 lessons · **DNA #136 born** 🧬 |
| 8 | verdict | 0s | Gen 3 · 8 stages · 7 missions total · 13 LLM calls |

## Evolved queries born this generation (origin: evolved:gen3)

Targeted at `anthropic-ai/claude` — hunting premium/fable tier mentions:

```
repo:anthropic-ai/claude "5.5" in:readme
repo:anthropic-ai/claude "fable" in:readme
repo:anthropic-ai/claude "premium model" language:python
repo:anthropic-ai/claude "5.5+" language:python
repo:anthropic-ai/claude "opus 5.5" language:python
repo:anthropic-ai/claude "premium" language:python
repo:anthropic-ai/claude "elite model" language:python
repo:anthropic-ai/claude "5.5 model" language:python
repo:anthropic-ai/claude "advanced model" language:python
...
```

## Mission #7 — `api-fortress-dominance`

Compiled from live intelligence + selected genes. Goal (auto-generated):
> הקמת צוות קטן לבדיקת והערכת simonw/llm-anthropic ו-forkadarshp/modelport — מבוסס על המודיעין החי מהציד (מוביל: simonw/llm-anthropic)

Executed 3/3 steps without human input.

## Cross-verification

- API verdict: `dnaBefore:110, dnaAfter:129, llmCalls:13, done:true`
- DB raw count: `{dna:129, chimera:3, mission:7, liveHunt:3}` — **match**
- Evolution chain intact: gen1 → gen2 → gen3 (`seededFrom:2`), blind-spot inheritance propagated every generation

## Cumulative (3 generations)

| Gen | DNA Δ | Key output |
|---|---|---|
| 1 | 94→101 (+7) | Chimera #2 · Mission #5 `reverse-engineer-fable-mode` |
| 2 | 101→110 (+9) | caught "fable"/"5.5" traces in anthropic repos |
| 3 | 110→129 (+19) | Mission #7 `api-fortress-dominance` · 913 unseen candidates · DNA #136 |
