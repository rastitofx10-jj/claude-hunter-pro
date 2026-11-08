# Honesty Audit — Round 2 (deeper pass, adversarial methods)

Round 2 mandate: "examine again, with better methods; don't trust claims — prove code."
Round 1 (`audit-honesty.md`) found 3 false claims + closed 2 quality gaps. This round attacked
**the fixes themselves** and **everything round 1 did not cover**. Method change: instead of
reading code and matching claims, we **ran the code adversarially** (21 hostile inputs against the
model gate), **replayed API calls outside the app** and compared against DB evidence, and
**traced every number** in the Gen 5/6 stage evidence to its producer.

## What held up (proven, not claimed)

| Claim | Proof method this round |
|---|---|
| 5.5+/fable gate is real and enforced | **21/21 adversarial tests pass** (`scripts/test-model-gate-adversarial.mjs`): bare `fable` rejected, `claude 5` blocked (5.0<5.5), `opus 45`/`sonnet 55` rejected (maj>9 guard), date suffixes handled, comma decimals accepted. Gate enforced at 3 layers: query arsenal is generated only from ≥5.5 registry (`deep-sweep.buildQueryArsenal`), server filter blocks 4.x strings (`/api/search` line 80), mining requires hard/capability evidence (`deep-sweep.mineTopCandidates`) |
| GitHub numbers are really fetched | Direct `curl` to `api.github.com` with the DB token returned `total_count: 323,584` for `claude-fable` — matches the app's recorded 321,536 (normal count drift). The app does not invent counts |
| Gen 5/6 internal arithmetic | Gen5: 935 candidates − 22 known = 913 novel; +2 mined +1 born = DNA 126→129 ✓. Gen6: 1524 − 935 = 589 novel (61% repeat) ✓; +14 mined +1 born = 129→144 ✓. All traced to `stages` evidence JSON |
| Chimera synthesis mechanism | `genesis.ts dnaDigest()` feeds real artifact content to the LLM; `Chimera.sources` column records the source repos per chimera (verified all 4 rows — e.g. #4 lists exactly the 5 repos claimed) |
| Mission #10 SKILL.md is AI-produced | `Mission.skillMdSource = "ai"` in DB; 3,475 bytes, valid frontmatter |

## ❌ New lies/gaps found in round 2 (all fixed below)

1. **"Genes" that were test artifacts.** Gen 6 — the *"first fully-honest run"* — mined
   `backend/internal/config/mcp_config_test.go` (a **Go test file**) as gene #155 labeled
   `mcp-config`, and `e2e/fixtures/.../SKILL.md` (a **Playwright test fixture**) as gene #108.
   Root cause: `dna-miner.classify()` matched `p.includes("mcp_config")` and `skill.md` anywhere
   in the path, with zero test-path exclusion. **Fix**: `TEST_PATH_RE` rejects `tests?|__tests__|spec|fixtures`
   paths and `*_test.*`/`*.spec.*` files; both genes purged from the DB (library 144→142).
2. **3 of 8 born field-DNA genes were malformed.** #94/#95 were born as `yaml name:...` and #138
   as ` ```markdown name:...` — fence leakage that no one caught because born DNA was never
   shape-validated (round 1 fixed mission SKILL.md but **missed the grow stage entirely**).
   **Fix**: `normalizeBornSkillMd()` applied in `distillFieldReport`; #94/#95/#138/#136 repaired
   in DB — all field genes now carry valid frontmatter.
3. **Duplicate execute stage records inflated stage counts.** The final execute run appended
   without filtering the previous one → every hunt reported "9 stages" instead of 8.
   **Fix**: filter in `runNextLocked` for execute terminations; all 6 historical hunts deduped in
   DB (verified in UI: now shows "8 שלבים").
4. **`llmCalls` is a lower-bound estimate, not a count.** swarm/attack are measured, but
   compile=+2 and execute=+1 were hardcoded formulas, and grow counted +1 **even when AI distill
   failed and fell back to local**. Internal retries (compilePlan ×3, compileSkillMd ×2,
   distill ×2, executor ×2) are invisible. **Fix**: grow now reports measured `llmCalls`
   (0 when local fallback); verdict evidence now carries `llmCallsBasis` stating the method.
5. **Re-mining proven-empty repos every generation.** simonw/llm-anthropic was mined in Gen 5
   AND Gen 6, returned 0 artifacts both times, and would be mined forever. **Fix**: persistent
   `mineAttempts` memory (Setting key); repos with 2 empty mining attempts are skipped, and the
   skip count is published in the mine evidence as `emptySkipped` — nothing hidden.
6. **SKILL.md "AI-grade" ≠ DNA-derived.** `compileSkillMd()`'s prompt receives **only the plan**
   (goal + phases) — zero DNA content. The 8 selected genes influence the SKILL.md only
   second-hand (through the plan). Claimed as "compiled from genes" in past sessions; the honest
   statement: the **plan** is DNA-informed (dnaBrief with 1,400-char content excerpts), the
   **SKILL.md** is plan-derived. Documented; not hidden behind "ai" label.
7. **Known limitation, now stated:** string-matching can't tell "Opus 6" the wine/vodka brand
   from Opus 6 the model (verified: both classify as qualifying). Also **27% of genes (39/144)
   are truncated at the 12KB mining cap** with a visible marker, and the library holds ~12
   duplicate names (e.g. `nativeprompt` ×3 from one repo) — de-dup happens at mission-compile
   rank time, not at storage. Stated here so nobody over-counts "unique capabilities".

## Environment disclosure (the meta-honesty item)

The app queries `api.github.com` and the sandbox serves it a GitHub world-state containing
`claude-fable`/`claude-opus-5-6`/`claude-opus-7` ecosystems with 2026 timestamps. We verified the
app faithfully records what this API returns (direct curl cross-check), but we **cannot
independently verify that source against the outside world from inside the sandbox**. Every
number downstream — candidates, stars, repos — is exactly as real as that source. Any report that
implied "hunted the real GitHub as you know it" was over-claiming; the precise claim is: *hunted
the GitHub API this environment serves, at 5.5+ threshold, with evidence archived per stage*.

## Fix-by-fix verification

| Fix | Where | Verified how |
|---|---|---|
| Test/fixture path gate | `dna-miner.ts` | 2 genes purged; re-classification of `mcp_config_test.go` returns `null` under new regex |
| Born-DNA normalization | `mission-compiler.ts` `normalizeBornSkillMd()` | 4 genes repaired in DB, all now `^---\n` + name + description |
| Execute dedup | `live-hunt.ts` `runNextLocked` | 6 hunts repaired 9→8 records; UI re-render confirms "8 שלבים" |
| Measured grow counter + basis note | `live-hunt.ts` `stageGrow`/`stageVerdict` | evidence schema carries `llmCalls` + `llmCallsBasis` |
| Empty-mine memory | `deep-sweep.ts` `mineTopCandidates` | `mineAttempts` Setting + `emptySkipped` published in mine evidence |
| Adversarial gate tests | `scripts/test-model-gate-adversarial.mjs` | 21/21 PASS (`bun scripts/test-model-gate-adversarial.mjs`) |

Standing rule (added to round 1's list): **6. An "AI-grade" label states what the artifact is
derived FROM — plan-derived is not gene-derived.**
