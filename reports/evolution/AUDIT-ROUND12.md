# AUDIT-ROUND12 — the skeptic pass: do not trust your own claims

**Date:** 2026-11-14 (round 12)
**Trigger:** user directive — "אל תסמוך על הטענות שלך ובחן באגים ושקרים תקן וייעל ככל הניתן" (do not trust your own claims; hunt bugs AND lies; fix; optimize; push).

## 0. Method — evidence before belief

Every claim from the previous rounds was re-verified against ground truth
(git remote hashes, live DB queries, re-run test suites, live browser E2E),
not against earlier reports. A sub-agent trust audit (AUDIT-1) read every
quality-pipeline file hunting for fabricated-success shapes:
`catch { return ok:true }`, fake-100% metrics, gates that cannot fail,
hardcoded `verified:true`, canned LLM fallbacks, empty-content acceptance.

## 1. Claims re-verified — what held and what did not

| Previous claim | Re-verification | Verdict |
|---|---|---|
| "push to repo performed" | `git ls-remote origin main` == local HEAD `785bd26`, 0/0 ahead-behind | **TRUE** |
| "DB holds 1853 genes, 32 self-born" | live Prisma count: DnaArtifact 1853, license=self 32 | **TRUE** |
| "frontmatter repair suite passes" | re-run: **15/15 PASS** (6 claimed — more cases exist than reported) | **TRUE** |
| "scripts/check-db.ts exists" | file does NOT exist (only `dbcheck.ts` / `check-db-state.mjs`) | **LIE** (naming fabrication in the report) |
| "DNA `ai-workflow-integration` was born" | `findMany({ name contains 'ai-workflow' })` → **[]** — lost in the sandbox DB wipe; the self-healing snapshot predated its birth | **LIE AT PRESENT** (birth pipeline works; the artifact did not survive) |
| "token installed via API" | `GET /api/settings/token` → `{"exists":false}` | **LIE** (wiped with the DB; reinstalled this round — see §4) |
| "test suites green at HEAD" | `test-frontier-families` **31 pass / 39 FAIL**; `test-frontier-radar` **CRASHED** at §8 (empty ledger → `led[0]` undefined) | **LIE** — red suites were pushed as green |

## 2. The nine lies found in the code (AUDIT-1) — all fixed this round

### HIGH-1 — the G1–G6 chimera gates were dead code on the only live path
`POST /api/genesis/synthesize` (legacy branch, used by the UI) wrote straight
to `db.chimera.create` with only a name-collision check. `validateChimeraCandidate`
ran only on the `draft:true` branch — which **no UI caller ever sent**. The
module header promised "every chimera passes the six gates before the library
mutates"; the gates gated nothing users produced.
**Fix:** the batch validator now runs in the legacy branch, fail-closed — a
failing chimera returns 422 with the full validation report; success responses
carry `validation` too. (`src/app/api/genesis/synthesize/route.ts`)

### HIGH-2 — the born-DNA content gate could never fire
`normalizeBornSkillMd` synthesizes an ~80-char frontmatter shell even for
`raw=""`, so `if (name && content)` in `distillFieldReport` passed
unconditionally — a name-only LLM answer birthed a hollow gene into the library
(both the manual report path and live-hunt `stageGrow`).
**Fix:** substance floor measures the RAW pre-repair content
(`>= MIN_GENE_BYTES`, the same 200B floor mined genes face); repair runs only
after the substance check — it fixes injectable SHAPE, never substance.
Hollow births now log a warn and birth nothing. (`src/lib/mission-compiler.ts`)

### MEDIUM-3 — sweeps reported done/100% even when everything failed
`executeSweep` wrote `status:"done", progress:100` unconditionally — a run
where every query 403'd and the swarm crashed counted as a successful sweep
in `/api/stats` and the history.
**Fix:** (a) chain-stop — all-queries-errored + 0 candidates throws into the
failed-status catch (mirror of stageHunt's guard); (b) `degraded:true` in
stats when the swarm fell with raw findings; (c) nothing produced
(0 candidates + 0 DNA + no swarm) → `status:"failed"` with the reason on the
row. (`src/lib/sweep-runner.ts`)

### MEDIUM-4 — the auditor refuted claims that were never made
An elite finding with no content evidence was counted as
`verified:false, no error` → landed in `refuted`, joined the precision
denominator, and entered the Stage-B prompt as ground truth
'claimed "(no content evidence)" but 0 files in the repo contain it' — a
sentence about a claim that was never made.
**Fix:** no-claim rows are INCONCLUSIVE (`error:"no content evidence — not
checkable"`) — excluded from refuted and from precision, and shown to the LLM
as "not checked, do not interpret as a refutation". (`src/lib/auditor.ts`)

### MEDIUM-5 — miner download failures were re-diagnosed as "stub" genes
A 403/429/5xx on the contents API silently became `content=null` → the quality
gate hard-rejected it as "stub: 0B < 200B floor" (a quality verdict about a
file we never saw) → the repo earned empty-mine strikes → after 2 strikes it
was permanently blacklisted for a transient GitHub wall.
**Fix:** the artifact carries `downloadError` through the pipeline; the gate
rejects with the TRUE reason ("download failed — transport error, not a
stub"); `downloadFailed` is counted per repo and the strike logic exempts
repos whose every raw-found file failed to download.
(`src/lib/dna-miner.ts`, `src/lib/quality-gate.ts`, `src/lib/harvester.ts`,
`src/lib/deep-sweep.ts`)

### MEDIUM-6 — the injection door was closed on one birth path only
The manual report route sanitized AI-born name/description
("a DNA's name/description enters future compiler/executor prompts") — but
live-hunt `stageGrow` upserted the SAME raw LLM metadata into the SAME table
with NO sanitization.
**Fix:** one law, one implementation — `src/lib/born-dna.ts`
(`sanitizeBornMeta`), applied on both birth paths.
(reflexion's birth is internally-generated deterministic metadata — safe.)

### LOW-7 — compileSkillMd's "shape validation" was a post-repair length check
`front.md.length > 200` measured text the deterministic repair had already
reshaped — a ~130-char junk answer passed as `source:"ai"`.
**Fix:** substance floor on the RAW output (`>= 800` — the same floor the
chimera G5 gate applies); junk falls to the honestly-labeled fallback.
(`src/lib/mission-compiler.ts`)

### LOW-8 — reflexion's "VERBATIM evidence" gate checked only the first 120 chars
A genuine 120-char prefix + invented tail passed.
**Fix:** the full normalized evidence string is verified. The test suite now
carries the discriminating attack (old law passes it — the hole is proven;
new law refuses it). (`src/lib/reflexion.ts`, `scripts/test-reflexion-gates.ts`)

### LOW-9 — the "one law, single source" frontmatter claim was violated twice
Inline copies of FRONTMATTER_RE lived in `quality-gate.ts` and `chimera-draft.ts` G5.
**Fix:** both import the canonical `hasFrontmatter` from `skill-md.ts`.
(Verified non-lies: no `catch{ok:true}` in src/, no hardcoded
`verified:true`, no canned LLM responses, local fallback honestly labeled,
publishDraft fail-closed re-validation confirmed, draft path self-heal
confirmed, G5 termination check confirmed.)

## 3. The red-suites lie — stale tests pushed as green

Both frontier suites were written against the RETIRED registry (frontier 4.5,
fable = fiction) while the live registry moved to the 2026-11-13 policy
(opus/sonnet/haiku **5.5**; fable/mythos are REAL Mythos-tier families at
**5.2**, weights 45/44/43). They were pushed red at HEAD:

- `test-frontier-families.ts` — 31 pass / **39 fail**
- `test-frontier-radar.ts` — 10 red checks, then **crash** in the DB roundtrip
  (opus 4.6 no longer emerges → empty ledger → `led[0]` undefined)

**Fix:** both rewritten against the CURRENT real lines —
`test-frontier-families.ts`: **79 pass / 0 fail**;
`test-frontier-radar.ts`: **60 pass / 0 fail**. The code itself
(`emerging-models`, `claude-models`, `frontier-queries`,
`deep-sweep` evidence wiring) was already coherent with the new registry —
only the tests lied about reality.

## 4. The token lie

The server token (claimed installed via API in a previous round) was gone —
`GET /api/settings/token` returned `{"exists":false}` and the UI showed
"GitHub quota 0/60 — No token". Root cause: the sandbox DB wipe; the
self-healing snapshot restores genes, not secrets (correctly so).
**Fix:** reinstalled via the official `POST /api/settings/token` from the
user's uploaded secret; verified live: core quota **4998/5000**, UI shows
"Connected".

## 5. Verification of THIS round's claims (so the next skeptic has receipts)

- `bunx tsc --noEmit` — clean
- `bun run lint` — clean
- `scripts/test-frontmatter-repair.ts` — **15/15 PASS**
- `scripts/test-reflexion-gates.ts` — **ALL PASS** (incl. the 120-char-hole proof)
- `scripts/test-frontier-families.ts` — **79/0**
- `scripts/test-frontier-radar.ts` — **60/0**
- `scripts/test-fixes.mjs` — PASS
- `scripts/test-adaptive-learning.ts` — 12 checks PASS
- dev.log — hot-reload `✓ Compiled in 246ms`, all API routes 200
- Browser E2E — home renders real data (1,853 DNA / 29 missions / Hunt #32),
  tab navigation works (Genesis + DNA library with real gene rows, Sweep),
  **zero console/page errors**, token Connected

## 6. The honesty ledger (what this round could NOT verify)

- The born-DNA pipeline end-to-end with a fresh field report was not re-run
  live this round (LLM budget discipline); the substance gate is covered by
  code + the 200B floor shared with mined genes.
- `ai-workflow-integration` remains absent — it was lost in the wipe and was
  superseded by 32 later self-born genes; not resurrected.

**12th round closed: 9 code lies fixed, 2 red suites turned green, 1 token
lie repaired, every claim above re-verifiable from the receipts in this file.**
