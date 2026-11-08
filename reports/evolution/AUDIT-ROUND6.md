# Claude Hunter — Round 6: Deepest Audit (2026-11-09)

**Mandate (user, Hebrew):** "תבדוק הכל לעומק ברמה הכי גבוהה שיש לעומק לשיפור מסיבי ותיקון נוסף על הגילויים ודחוף לריפו"
— examine everything at the highest depth, massive improvement, fix the findings, push to the repo.

**Method:** four parallel deep-audit passes over the four engine groups never
fully audited before (live-hunt chain, mission/autopilot runtime, sweep+audit
pipeline, analyze/search/token contracts) — **85 findings** (7 CRITICAL/HIGH
clusters), of which this round fixed **~70** across 25 files. Every fix was
verified: typecheck 0, lint 0, verify **73/73** (58→73), production build +
standalone, and a live end-to-end against real GitHub + real LLM calls
including deliberate failure injection.

---

## 1. The headline bugs (all fixed + live-verified)

### 1.1 The infinite retry loop that burned quota unattended (CRITICAL)
A failed live-hunt stage re-fired itself forever: the route attached the failed
state to the error payload, but `apiFetch` threw the payload away before the
panel could read it — so the panel's pump (status still "running") called
`next` again every 700ms, and the server (no failed-guard) re-ran the entire
failing stage each time. A failing `compile` burned 2 LLM calls × 3 retries per
cycle; a failing `hunt` re-fired a 26-query GitHub volley (~2.5 min) forever.
**Fix (3 files):** `runNextLocked` 409s on `status:"failed"` **with the failed
state attached to the error**; `apiFetch` attaches the error payload to the
thrown Error; the panel's `onError` reads `payload.hunt`, stops the pump and
shows the retry button. **Live-verified by failure injection:** 409 +
`hunt.status:"failed"` + the injected error text in the payload.

### 1.2 Empty hunts manufactured missions from nothing (HIGH)
0 candidates (or no token) still ran all 8 stages — LLM calls on empty lists, a
mission compiled from a generic fallback goal, a green "done" verdict.
**Fix:** fail-fast on missing token (400, precise message); abort the chain
with a counted error when `candidates.length === 0`.

### 1.3 Generational seeding starved the market dimension (HIGH)
Evolved queries (≤10) were budgeted by head-slicing the arsenal: gen≥2 ran
**zero** of the 7 repo/market/topic searches and dropped 2 queries even in
gen 1. The seeding meant to ADD coverage was deleting whole dimensions.
**Fix:** category-aware budget (repo-first, registry-code before capability),
`MAX_HUNT_QUERIES` 24→32 — no static query is ever dropped. **Live:** 26/26
arsenal queries ran in the E2E hunt.

### 1.4 "Re-rank after enrichment" was a no-op (HIGH)
Scores were computed once with pre-enrichment stars (0 for code-search hits);
the "re-rank" sorted by the stale values — a 10k-star repo ranked as 0-star in
the top-cut, elite selection and mining choice. **Fix:**
`scoreCandidateInPlace` (single source) recomputed after GraphQL enrichment.
**Unit-verified** (score rises with stars) and live (sweep/hunt both rank on
real stars).

### 1.5 API errors were fed to the auditor as refutations (HIGH)
A rate-limited/timeout evidence check (`verified:false, error:...`) was
presented to the anti-slop LLM as *ground truth the claim was false* and
dragged precision down. **Fix:** errored checks split out as *inconclusive* —
excluded from the precision denominator, listed to the LLM as "do not
interpret as refuted", rendered amber in the panel (not red "נסתרה").

### 1.6 Stuck `running` rows deadlocked forever (HIGH)
Sweeps had a stale reaper; audits and hunt-retries didn't. A crash mid-audit
or a retry against a zombie left the button disabled and 409 forever.
**Fix:** 15-min stale reaper for audits (marked failed, re-runnable);
`retryLiveHunt` checks for an active run before flipping failed→running.

### 1.7 `captureTokenFrom` was dead code (HIGH)
It compared the request header against `resolveToken(req)` — which returns the
request header itself — so `persistToken` never ran. All five routes' "capture"
comments described a no-op. **Fix:** compares against the stored DB value.
**Live-verified:** a garbage header yields 401 from GitHub AND the stored token
is untouched — capture only runs after GitHub validation.

---

## 2. Mission runtime (execute/grow stages)

- **Status-stomp race closed:** the final write re-reads status inside the
  lock (a field report landing `done` during the 110-220s `executePhase` was
  stomped back to `in_progress` before).
- **Transient failures retry:** a single LLM timeout permanently failed a
  phase with no recovery. Now timeouts are marked `transient` (attempts≤2) and
  retried on the next step; one failure record per phase (no duplicates).
- **Report save is truly atomic now:** DNA upsert + history merge + status in
  ONE transaction; the old comment claimed "report first" while the upsert
  actually ran first — an update failure orphaned the born DNA and lost the
  report. Concurrent reports close with a compare-and-swap `updateMany` +
  retry loop. **Live-verified:** two parallel reports both survive (the second
  write used to drop the first).
- **DELETE cascades** the born DNA (`field:mission-<id>`) in the same
  transaction (was orphaned forever, still ranking +2 into future compiles);
  the UI asks for confirmation first.
- **`executePhase` fence-strip fix:** the blanket ```` ``` ````-replace
  destroyed inner code blocks in deliverables (same bug class fixed in
  compileSkillMd 260 lines above) — now `stripOuterFence`.
- **Born-DNA metadata sanitized** (control chars, caps) and moved inside the
  untrusted-content wrapper in compiler/executor prompts — it was a
  persistent prompt-injection channel in the *trusted* zone.
- skillMdSource: legacy rows now "unknown" instead of laundering as "ai";
  mission list returns the real total; step route maxDuration 120→300.

## 3. Sweep + adversarial audit

- findings capped to `SWARM_TRIAGE_COVERAGE` (36) — 60 were saved with only 36
  triaged; rows 37-60 showed "pending" forever. **Live: 36 findings, 0 pending.**
- Mining failures surfaced (`stats.mineErrors`, `reposWithFindings`, error
  list) instead of `void minedReports` — "3 מאגרים נכרו" could hide 5 failures.
- Ground-truth raw-file grep uses the union of all claims' needles (was:
  the last claim's — cross-model paths grep'd with wrong strings).
- `startAudit` lock genuinely before any await; `enriched` counts only real
  GraphQL recipients; `isCapabilityPath`/`TierKey` deduplicated to one source.
- Panel: list polls while a run is active, launch auto-follows the new run,
  badges corrected, honest mining row under the stats grid.

## 4. Search / analyze / token contracts

- **Code-mode star enrichment (live-verified):** REST code-search items carry
  no stars; 1-2 GraphQL calls now enrich them — "claude-opus-6" returned repos
  with real stars 46,860/21,619/1,253 where every card previously showed ⭐0.
- `topic:` no longer injected into code mode (guaranteed 422); `sort`/`language`
  validated+encoded; `repoCount` counts what the user actually received.
- paidScore now counts only true payment evidence (dep|env|mcp|cost) — a
  purely structural repo reached 30/30 "payment & API evidence" before.
- env evidence requires an actual `ANTHROPIC_API_KEY=` line; in-repo model
  search runs longest-identifiers-first and skips subsumed shorter ids
  (`"claude-opus-6"` matched 6.5-only repos as Opus 6); tree-miss files try ALL
  guesses (`CLAUDE.local.md` was never tried); per-model search uses
  ghSearchWithBackoff with no trailing sleep.
- History dedup: paging/re-running a search writes no new rows (5 pages used
  to create 5 identical rows). **Live: before=7 after=7.**
- **Raw PAT off the client:** the store only holds `""`/`@server` (a legacy raw
  PAT in localStorage is replaced by the sentinel on rehydrate); banner/dialog
  save flows set the sentinel only after the server POST succeeds; dialog
  "clear" deletes the server token too; masked display from the server.

## 5. Infrastructure

- `STATUS_RANK`/`OUTCOME_STATUS` unified into `src/lib/mission-status.ts` (was
  defined ×3 with drift — one had already drifted).
- `@@index([status])` on SweepRun + LiveHunt (status is queried on every
  start/step/reap); schema comments now match the code (`partial`, `attack`).
- `previousKnownRepos` computed once per hunt (was 2×); swarm auto-archive is
  1 `findMany` instead of 12 `findUnique`; stageCompile loads capped content
  (substr 4000) + true length (`contentLen`) through the ranker; executor DNA
  fetch sliced to the 6 ids actually used; grow report entries dedupe by
  source; compile/grow are idempotent after crashes (mission link written in
  the same transaction as the mission; a retry reuses the linked mission).

## 6. Live end-to-end (all green, against real GitHub + LLM)

| Phase | Result |
|---|---|
| Search code-mode | 4 repos, 3 with real stars (was always 0); repeat search: 0 new history rows |
| **Full live hunt** | 26/26 arsenal queries · 8 stages · mission #2 linked · DNA 69→81 · llm=14 · 438s · mine honesty fields · grow dnaBirthError surfaced |
| Parallel double report | both entries in history (lost-update closed) · status stays `done` |
| Failure injection | failed hunt → **409 + failed state in payload** (infinite pump re-run is dead) |
| **Full sweep** | 36 findings = triage coverage, 0 eternal-pending · reposWithFindings 4/8 · 292s |
| Adversarial audit | 100% precision · 9 checks · refuted/inconclusive split live |
| verify suite | **73/73** (58 → 73) |
| typecheck · lint · build · standalone | 0 · 0 · exit 0 (24 routes) · :3100 serving real data |

## 7. Known trade-offs (documented, deliberate)

- Mutation routes remain unauthenticated (single-user local tool; middleware
  blocks cross-origin browsers). Blast radius documented; changing it would
  break the verify harness and the preview flow.
- Token sits raw in the `Setting` table (local SQLite, gitignored) — same
  exposure class as `~/.netrc`; the *client* no longer persists it anywhere.
- The legacy "no double quotes in JSON" prompt rule (ai-intel/genesis) was
  evaluated and **deferred**: removing it changes live LLM behavior and the
  current form is verified by 73 checks; revisit with a dedicated live probe.
- One-time migration: a raw PAT that was in localStorage before this round is
  replaced by the sentinel on next load; if the server lacks it, the user
  pastes once more (capture then re-stores it server-side).

## 8. Files touched (25)

live-hunt.ts · api-client.ts · live-hunt route + panel · autopilot.ts ·
mission-compiler.ts · mission-status.ts (new) · report/[id]/mission routes ·
mission-control.tsx · deep-sweep.ts · intel-swarm.ts · sweep-runner.ts ·
auditor.ts · sweep route panel · server-token.ts · hunter-store.ts ·
token-banner/dialog · rate-chip · overview · hunter-types · github.ts ·
search/analyze/intel/synthesis routes · prisma/schema.prisma ·
verify-round4.ts (58→73) · e2e-round6.ts (new)
