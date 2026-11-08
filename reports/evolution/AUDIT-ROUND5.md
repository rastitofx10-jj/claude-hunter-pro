# Claude Hunter — Round 5: Kill-Chain Engineering Audit (2026-11-09)

**Mandate (user, Hebrew):** "באגים, חוסר יעילות הנדסית — בחן הכל, תקן הכל, שפר הכל. קציר נכשל. צריך לבדוק כימרה, סריקות, מבצעים — הכל. שיפור חד, מקיף וקיצוני."

**Scope:** every engine in the kill chain — harvester, chimera (genesis), sweeps, missions,
live-hunt swarm — audited for bugs, silent failures and efficiency. All fixes verified live
against real GitHub + real LLM calls, then the full 58-check suite + production build.

---

## 1. The two field-measured facts that drove this round

Both were measured live (probe scripts, this session) before a single line was changed:

**F1 — The LLM endpoint allows exactly ONE concurrent call.** Two parallel calls → one
returns `429 Too many requests`. Three parallel → two rejected. Sequential rapid-fire →
all pass (~550ms each). A 429 retried immediately after → passes. Conclusion: it is a
**concurrency gate, not a quota**. Before this round nothing serialized the app's AI calls:
a chimera synthesized while a sweep's swarm phase ran, or a field-report distilled during
autopilot, collided and one engine died with a raw SDK error surfaced to the user.

**F2 — REST code-search items do NOT carry stars** (the `repository` object is "minimal"),
but **GraphQL returns stars + pushedAt + defaultBranchRef for up to ~40 repos in ONE
request costing 1 point** from the same 5000/h pool. The old pipeline paid 25–30 REST
`/repos/` calls per harvest/sweep for the same data.

## 2. Critical fixes

### C1 — Global LLM queue + 429 retry (`src/lib/zai.ts`, all 8 call sites)
New `llmComplete()`: process-wide serial queue (concurrency 1), gentle 429 retry
(1.5s → 3s), per-attempt timeout that starts **when the call leaves the queue** (waiting
behind a swarm no longer eats the 110s budget), timeout errors flagged through the shared
`markTimeoutError` so every engine's "don't retry a timeout" logic keeps working.
Migrated: intel-swarm, ai-intel, genesis, auditor, mission-compiler (×4).
**Live proof:** chimera synthesis + mission compile fired simultaneously — both completed
(chimera 7,073-char skillMd + 4 work orders; mission 3 phases, 5 prompts,
`skillMdSource: "ai"`). Before the queue one of the two would 429.

### C2 — `role:"assistant"` was being used as the system prompt at all 8 LLM call sites
The system instructions were sent as a fake prior assistant message. Switched to
`role:"system"` (verified the endpoint accepts it). Mission SKILL.md now comes back
`skillMdSource: "ai"` instead of falling back to the local template.

### C3 — Harvester swallowed every failure silently
- Both discovery queries rate-limited → caught, discarded → UI showed
  "הקציר הסתיים · נכרו 0" with zero explanation.
- A repo whose mining threw was dropped from `Promise.allSettled` rejections — invisible.
- Discovery used raw `ghFetch` (no backoff) instead of `ghSearchWithBackoff`.

Now: every query outcome and every repo failure is reported
(`queriesRun`, `queriesFailed`, `reposFailed`), the route maps an exhausted GitHub quota
to a precise **429** response, and the UI renders failure boxes inline in the harvest report.

## 3. Efficiency upgrades ("get much more")

| Change | Before | After | Measured |
|---|---|---|---|
| Harvest/sweep enrichment | 25–30 REST `/repos/` calls + sleeps | **1–2 GraphQL calls** (stars+branch batched ×40) | enrich phase ~10s → <1s |
| `/repos` per mined repo (default branch) | 1 extra call each | passed through from GraphQL | −6…−8 calls per run |
| Harvest discovery coverage | 2 hardcoded queries | **6 registry-derived** (every 5.5+ model id) | 181 → **396 candidates** |
| Harvest DB writes | findUnique+update/create per gene (N+1) | 1 findMany + upsert only when content changed | identical genes now skipped |
| Raw-content mining | 12 parallel × 2 repos = 24 open requests | shared `mapLimit(…, 6)` pool | secondary-limit safe |
| Frontmatter parsing (CRLF repos) | `^---\n` never matched Windows files | `^---\r?\n` + quote-stripped names | names extract correctly |

## 4. Live end-to-end verification (all green)

| Engine | Result |
|---|---|
| Harvest (API, maxRepos=3) | 396 candidates · 6 queries (0 failed) · 3 repos · +6 genes · GraphQL stars exact |
| Harvest (UI click, maxRepos=6, during a running sweep) | +19 genes → library 42 · live elapsed timer · report with stars & badges · zero failure boxes |
| **Chimera + mission compile in parallel** | both succeeded through the queue (the C1 proof) |
| Full sweep | 26 queries · **0 errors** · 1,487 code hits · 1,566 candidates · 978 hard-evidence · 8 repos · +27 genes → library 69 · swarm 9 LLM calls **0 failures** · 11 elites · 5.5 min |
| `bun run verify` | **58/58** (52 previous + 6 new: timeout flag, mapLimit order/bound, queue parallel-pair) |
| typecheck · lint · production build · standalone start | 0 · 0 · exit 0 (all routes) · 200 + 69 genes served |

## 5. What "the goal" is, in numbers (answer to "מה המטרה, איך לייעל ולקבל הרבה יותר")

The system's throughput ceiling is **GitHub code-search quota (10/min)** for discovery and
**LLM call latency (~2–5s each, serialized)** for synthesis — both are external, so the wins
come from wasting none of them:

- Discovery: 6 well-formed registry queries per harvest ≈ 40% of the per-minute code-search
  budget; the rest belongs to sweeps. A harvest+sweep per hour is comfortably inside quota,
  and the backoff now survives collisions instead of dying.
- Enrichment is now ~free (1 GraphQL point per run instead of 25–30 REST calls).
- Every engine can run concurrently without 429s — the queue is the single serialization
  point, so "harvest during sweep, chimera during mission" is now a supported workflow.
- Remaining headroom (deliberately not done this round): parallel REST+GraphQL is safe to
  widen (mapLimit up to ~10), and search could move to GraphQL `search(type: CODE)` —
  but its rate cost is equivalent, so the current REST+backoff design is already at the
  practical ceiling for one token.

## 6. Files touched

- `src/lib/zai.ts` — rewritten: queue + retry + per-attempt timeout
- `src/lib/ai-json.ts` — `markTimeoutError` export
- `src/lib/github.ts` — `ghGraphql()`, `mapLimit()`
- `src/lib/harvester.ts` — rewritten discovery (registry queries, GraphQL batch, honest reports, upsert, precomputed branch)
- `src/lib/dna-miner.ts` — optional defaultBranch, mapLimit(6), CRLF frontmatter
- `src/lib/deep-sweep.ts` — GraphQL enrichment, branch pass-through to mining
- `src/lib/intel-swarm.ts`, `src/lib/ai-intel.ts`, `src/lib/genesis.ts`, `src/lib/auditor.ts`, `src/lib/mission-compiler.ts` — llmComplete + role:"system"
- `src/app/api/harvest/route.ts` — 429-aware error mapping
- `src/components/hunter/genesis-panel.tsx` — live timer, failure boxes, wider query list
- `scripts/verify-round4.ts` — +6 checks (58 total)
