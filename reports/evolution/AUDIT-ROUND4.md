# Audit Round 4 — Chief Engineer Review

**Date:** 2026-11-09 · **Branch:** `fix/round-4-chief-engineer` · **Base:** `db4ac99` (audit round 3)
**Scope:** full codebase review (lib + 24 API routes + UI), fix of every critical/high finding,
end-to-end completion, and a ground-up UI rebuild.

**Verdict up front:** the engine layer (post rounds 1–3) was already solid; the honest
headline of this round is that **the build was lying** — `ignoreBuildErrors: true` shipped 12
real type errors to production, two of which were genuine runtime bugs (dead rate-limit
backoff; string[] fed to a function that needs objects). Round 4 makes the build honest
again and closes 21 defects, then rebuilds the interface at a far higher level.

---

## 1. Findings and fixes (by severity)

### CRITICAL

| # | Finding | Evidence (before) | Fix |
|---|---|---|---|
| C1 | **Build hid 12 real type errors** — `typescript.ignoreBuildErrors: true` in `next.config.ts`; typecheck failed while `next build` passed | `tsc --noEmit` listed 12 errors; production shipped them | Flag removed. typecheck=0, lint=0, `next build` green in a clean copy. No error class can silently ship again |
| C2 | **Dead rate-limit backoff** — `ghFetch` translates the 403 message to Hebrew, then `searchWithBackoff` (deep-sweep + auditor) matched the English `"rate limit"` inside that Hebrew text → never matched → every rate-limited query failed permanently instead of waiting 8s/16s/32s | `searchWithBackoff` in both files; the same bug existed in two copies | `GhError.rateLimited` flag set at the single source of truth (`ghFetch`); both copies replaced by one shared `ghSearchWithBackoff` in `github.ts` |
| C3 | **`runSwarm` type lie = runtime bug** — signature declared `executedQueries: string[]`; the sweep caller passed `arsenal.map(q => q.q)` (strings) → `queryEvolution` rendered "undefined תוצאות" for every query and the dead-query list was always empty | `intel-swarm.ts:370` + `sweep-runner.ts:113` | Signature now `{q,count,error}[]`; sweep-runner passes real `reports.map(...)`. Guarded at the type level so it cannot regress silently |
| C4 | **Watchlist silent data wipe** — client sent `models: null` from the search-card path; route treated present-but-null as "set null" → saving a repo from a search card erased models stored earlier from deep analysis | `watchlist/route.ts:44` + `page.tsx:81` | Explicit null no longer updates; only real non-empty values write. Client stops sending `models: null` at all |
| C5 | **Destructive wipe without intent** — `DELETE /api/dna-library` with no params wiped the WHOLE library; `?repo=` with an empty value fell through to wipe-all (one typo away from irreversible data loss) | `dna-library/route.ts:70-72` | Wipe requires explicit `?all=1`; empty repo param is a 400. Genesis panel updated to send `?all=1` |

### HIGH

| # | Finding | Fix |
|---|---|---|
| H1 | `startLiveHunt` TOCTOU — two parallel "start" clicks could both pass the `findFirst` check and create two concurrent hunts | `startingHunt` start-lock (same pattern as `startSweep`) |
| H2 | `live-hunt.ts` used `SweepQuery` without importing it (TS2304); `c.tierLabel` read off `Candidate` (doesn't exist — only `CandidateFlat` has it) so evidence JSON silently lost the field; verdict type omitted `novelTop` though the data exists | Import added; `tierLabel` computed via `tierOf(min(100, score))`; `novelTop` declared |
| H3 | `executePhase` stripped **all** ``` fences with a blanket `.replace` — every code example inside autopilot deliverables was destroyed | `stripOuterFence` only removes the wrapping fence (same policy as SKILL.md) |
| H4 | Unbounded DB reads: `export/pack` full-content `findMany` with no take (library grows forever via auto-harvest); `dna-library?full=1` unbounded | `take: 600` / `take: 400` respectively |
| H5 | `history`/`watchlist` DELETE: catch-all 400 for every failure — P2025 should be 404, server faults 500; no logs | `isPrismaNotFound` → 404; real 500s with `console.error` |
| H6 | Raw `e.message` leaked to clients in six routes (Prisma internals, network internals) | Sanitized client messages + server-side logs everywhere |
| H7 | `settings/token` mapped ANY verification failure to 401 "token rejected" — including network errors that have nothing to do with the token | 401 only for 401/403 from GitHub; network failure → 502 with a clear message |
| H8 | `mission PATCH` same-status transition returned a guaranteed 409 (`in_progress → in_progress`) — the UI button was dead on any already-in-progress mission | Same-status PATCH is an idempotent 200 no-op |
| H9 | Chimera `oneLiner` never persisted; history faked it from `breakthrough` — the AI-written headline was lost forever | Schema column added (additive migration); routes persist + return the real value; `breakthrough` only as legacy fallback |
| H10 | `analyze` built `claudeFiles[].url` with raw path interpolation — `#`/`?`/spaces break the link (dna-miner had already fixed the identical pattern) | Path segments `encodeURIComponent`-joined |

### MEDIUM

- **M1** `genesis/mine` never called `captureTokenFrom` — a valid header token used for mining wasn't persisted (analyze/harvest/rate-limit did). Fixed.
- **M2** `productContext` accepted unbounded input in `genesis/synthesize` (mission routes cap, this one didn't). Capped at 2000.
- **M3** `mission POST` response omitted `reportHistory` (GET returns it; the client type declares it; route comment promised "exactly the same shape"). Now included; the UI renders the timeline (was dead data).
- **M4** Negative IDs accepted as 404 instead of 400 (`autopilot/step`, `dna-library/[id]`). `id>0` guards everywhere.
- **M5** `api-client` headers union produced TS2769 (hidden by C1). Explicit `Record<string,string>`.
- **M6** `monthAgo` variable actually held a 120-day cutoff — renamed `freshSince` (naming lied to every reader).
- **M7** Search with an empty `?repo=` / missing params semantics (covered by C5) plus `scope` in the response for observability.
- **M8** Watchlist input hygiene: no length caps, no URL validation on a field rendered as `<a href>`. Both added (github.com https enforced).
- **M9** `db.ts`/env ambiguity: relative `file:` URLs resolve against the SCHEMA dir (not root) and an exported `DATABASE_URL` silently beats `.env` — users kept "losing" their database. `.env.example` now uses schema-relative `file:../db/custom.db` (matches README + .gitignore), and `db.ts` logs the active `DATABASE_URL` at boot.
- **M10** `llmCalls` accounting for compile/execute uses documented lower-bound formulas (not measured) — kept, now explicitly labeled `llmCallsBasis` in evidence (was already marked in round 3; unchanged by design).

### LOW (noted, left alone deliberately)

- Role prompts are sent as an `assistant` message rather than `system` — unconventional but works consistently across all modules; changing prompt semantics mid-flight without LLM regression testing is riskier than the gain. Documented, deferred.
- `SavedRepo.evidence` is accepted but no client path sends it — left as optional plumbing.
- Double-counting of stars in candidate scoring (listScore already includes stars, plus `log10(stars)` term) — a heuristic weighting choice, not a correctness bug.
- `next` deprecation warning: the `middleware` file convention is deprecated in Next 16 in favor of `proxy`. Behavior is correct today; rename deferred to a dedicated upgrade pass.

---

## 2. UI rebuild (the round's headline request)

Interface torn down and rebuilt at a much higher level:

- **App shell** — right sidebar navigation with animated active pill, mobile chip-nav, sticky
  header (brand / iron-threshold badge / live rate chip) and sticky footer.
- **New Overview dashboard** — live KPI cards (DNA library, missions, hunts, GitHub rate),
  quick actions, recent-activity feed merging hunts + missions, doctrine panel.
- **Command palette (Ctrl+K)** — navigation, all search recipes, quick-analyze targets and
  theme switch; searchable in Hebrew and English.
- **Light/dark theme** — the README always promised כהה/בהיר; the toggle never existed.
  Now: `next-themes` ThemeProvider + toggle (verified: `documentElement.className === "dark"`).
- **Live Hunt rebuilt as a war room** — horizontal 8-stage rail with live per-stage states
  (done/active/failed), campaign hero with generation lineage, evidence viewer, campaign
  summary with proof numbers.
- **Mission Control** — report history timeline now actually rendered; typing widened to
  match what the server sends (types that lie less than code that lies more).
- **Genesis** — destructive library wipe requires explicit `?all=1`.

Everything else (analyze sheet, battle synthesis, sweep, search, watchlist, token banner)
kept its working round-1–3 structure and gained the shell + theme + palette around it.

---

## 3. Verification evidence

| Check | Result |
|---|---|
| `bun run typecheck` | **0 errors** (was 12 hidden) |
| `bun run lint` | **0 errors** |
| `bun run build` (clean copy, honest config) | **exit 0**, all 24 routes |
| `bun run verify` (new suite: 40 unit + 12 API) | **52/52** |
| Live GitHub E2E — token via app API | stored, masked `github_••••f731`, rate 4997/5000 |
| Live GitHub E2E — repos search | 200, 13,432 matches, real scored results |
| Live GitHub E2E — code search `claude-opus-5-5` | 200, 96 hard-evidence repos |
| Iron threshold on live server — 4.x model | **400** (server-enforced) |
| Cross-origin mutation (CSRF guard) | **403** |
| Agent Browser — home / war room / palette / dark | rendered, interactive, **0 console errors**; dark mode verified at DOM level + pixel luminance 20/255 vs 247/255 light |

## 4. Residual notes (honest reporting)

- **Sandbox state anomaly:** during this session, working-tree files intermittently reverted
  to pre-fix versions between tool calls (some files, not others, more than once). Root cause
  not identified; mitigation was to pin every verified state as an immediate git commit and
  re-materialize from HEAD (`git checkout <commit> -- .`). The final tree equals commit
  `ebbcc63` and was re-verified end-to-end after materialization. If a future session sees
  files "un-fix themselves", compare against the branch tip before assuming code drift.
- The old intermediate commit `de76532` from an earlier application attempt was superseded;
  its content is fully contained in `818d9d0` (the branch was fast-forwarded past it).
- No secrets in the repo: `git grep github_pat_/ghp_/gho_` over the tree matches only UI
  placeholder text and this audit's own descriptions; `upload/` (user token), `download/`,
  `db/`, `.env` are all gitignored — and the token is NEVER printed by any tooling in this
  repo; it is read at runtime from the upload only.

## 5. How to run

```bash
bun install
cp .env.example .env        # DATABASE_URL is schema-relative — see the comment inside
bunx prisma db push
bun run dev                 # or: bun run build && bun run start
bun run verify              # 52-check suite (unit + API smoke)
```
