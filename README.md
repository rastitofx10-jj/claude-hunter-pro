# Claude Hunter Pro

Competitive-intelligence hunter for the Claude ecosystem. The app scans live GitHub for repositories built with **premium Claude models (5.5+)**, scores each candidate for genuine token-investment signals, mines their capability files (SKILL.md files, slash commands, agent definitions, CLAUDE.md) into a growing **DNA library**, and compiles that DNA into autonomous missions it then executes stage by stage. Every executed mission files a field report that is distilled back into the library, so the system accumulates a capability memory no ordinary Claude session ever has.

> **Iron rule:** the model threshold is locked in code — only premium models qualify: the Mythos tier (Claude Fable 5.2, Claude Mythos 5.2) and Opus / Sonnet / Haiku **5.5 and above**. The 4.x family, Opus 5 / Sonnet 5 and everything older is real but blocked server-side, in the filters, and in the scoring. Pins above the known lineup (for example "opus 6") stay *unverified* until an Anthropic-owned repo confirms them. The threshold is not user-configurable from the UI.

## Key features

- **Premium-model detection (5.5+ gate, 4.x block)** — model identity is extracted from repo text, paths and code hits; qualifying models (>= 5.5) are separated from blocked ones (the whole 4.x family and below). Blocked-only candidates are disqualified, and blocked filter values are rejected server-side before they ever reach GitHub.
- **Token-investment scoring** — every repo gets a 0-100 Claude-investment score from traction (stars/forks), recency, and qualifying-model evidence, mapped to tiers from `Elite` down to `Seed`. Evidence is split into hard (model string inside a real file) and soft (mention in a description — never promoted to elite).
- **8-stage live hunt kill chain** — one click runs the full autonomous chain `hunt -> swarm -> attack -> mine -> compile -> execute -> grow -> verdict` (see below). One stage per call, state persisted in the DB, resumable from any point.
- **Deep sweep** — a full intelligence operation: an auto-generated query arsenal (code + repos + topics, always in sync with the model registry), metadata enrichment, DNA mining, and an 8-prompt intelligence swarm (triage -> profiles -> patterns -> attack plan -> query evolution -> briefing).
- **DNA library of mined capability genes** — every SKILL.md, command, agent, CLAUDE.md/AGENTS.md and MCP config mined from an elite repo is stored as a portable gene, ready for injection into any project (one-file Markdown export included).
- **Mission compiler + autopilot** — a natural-language goal becomes a battle plan with phases, a ready-to-paste prompt sequence and an operational SKILL.md, with automatic selection of the most relevant DNA. The autopilot then executes one phase per beat — resumable, guarded against concurrent runs. Field reports are AI-distilled into **new, field-born DNA** that is automatically picked for the next mission.
- **Genesis chimera synthesis** — merges the best-of-breed genes from several DNA-rich repos into a single chimera persona with principles, work orders and a breakthrough idea.
- **Adversarial auditor** — the system audits itself: live re-verification of elite evidence against the actual repos (code search + raw grep for ground truth) and an anti-slop prompt that demands exact citations.
- **Watchlist** — repos saved for tracking with detected models, evidence and notes, auto-saved from hunt verdicts.
- **Rate-aware GitHub client** — per-request timeouts, rate-limit detection (403/429) with exponential backoff, quota snapshots, and throttled parallel enrichment. The Claude side goes through a bounded-concurrency gateway with retry/backoff (see *Claude API layer*).

## The live hunt kill chain

```
hunt      26 live GitHub queries with the stored token -> ranked candidates (5.5+ threshold enforced in code)
swarm     LLM triage of the top 12 candidates + investment profiles for the elites
attack    market patterns + attack plan + query evolution + executive briefing
mine      live DNA mining from the top targets -> new genes in the library
compile   goal auto-derived from the attack plan -> mission compiled from the enlarged library
execute   autopilot — one mission phase per beat until all phases complete
grow      AI field refinement -> a new gene is born (field:livehunt-<id>)
verdict   campaign verdict: growth proven in numbers + full per-stage evidence
```

Generation 2+ hunts seed the previous hunt's evolved queries (up to 10) on top of the 26-query static arsenal, so every generation hunts beyond the last one's knowledge.

## Tech stack

- **Next.js 16** (App Router) + **React 19** + TypeScript 5
- **Prisma + SQLite** — models: `Mission`, `DnaArtifact`, `SweepRun`, `LiveHunt`, `Chimera`, `SavedRepo`, `SearchHistory`, `Setting`
- **Claude API (direct, zero SDK)** — `src/lib/llm.ts`: streaming Messages API client with a bounded concurrency pool, retry with `retry-after`, adaptive-thinking effort control, structured outputs, prompt caching and token/cost accounting
- **GitHub REST** — rate-aware client (timeouts, backoff, quota tracking, throttled parallel enrichment)
- **Tailwind CSS 4 + shadcn/ui** — English-only, left-to-right UI, light/dark theming
- **TanStack Query + zustand** — server state and local UI state

## Setup

```bash
bun install
# Environment: DATABASE_URL (SQLite) in .env — the file: path is resolved relative to
# the schema directory (prisma/), see .env.example for the exact note
bunx prisma db push
bun run dev
```

**GitHub token (optional but recommended):** either set `GITHUB_TOKEN` in `.env`, or paste a Personal Access Token into the token card at the top of the app — it is validated against GitHub, stored server-side (SQLite `Setting` table) and in the browser, and only ever displayed masked. Note: server-side storage is raw text in the `Setting` table; this tool is designed for local, single-user use. With a token stored, all capabilities open up: extended search, mining, deep sweeps and live hunts.

**DNA restore:** if the database was wiped (e.g. an environment recycle), reseed it from the committed snapshot — idempotent, and the PAT is never in the snapshot:

```bash
node scripts/dna-restore.mjs
```

## Claude API layer

Every AI feature (swarm, attack plan, missions, chimeras, audit) goes through one gateway, `src/lib/llm.ts`.

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...        # required for all AI features
bun run llm:check                   # live smoke test of every tier (one tiny request each)
```

| Tier | Default model | Used for |
|---|---|---|
| `frontier` | `claude-fable-5-2` | opt-in per call (highest capability) |
| `deep` | `claude-opus-5-5` | mission planning, phase execution, chimeras, adversarial audit, attack plan |
| `balanced` | `claude-sonnet-5-5` | swarm triage + investment profiles, report distillation |
| `fast` | `claude-haiku-5-5` | cheap classification calls |

Override with `HUNTER_MODEL_FRONTIER|DEEP|BALANCED|FAST`, parallelism with `HUNTER_LLM_CONCURRENCY` (default 4), gateway with `ANTHROPIC_BASE_URL`. `GET /api/llm` reports configuration, per-model token usage and estimated cost without calling the API.

The layer follows the 5.x request rules: no `thinking` field (adaptive thinking is always on), depth via `output_config.effort`, no sampling parameters, no prefill, no forced tool choice, JSON via `output_config.format`. Every request is streamed, system prompts are cached, 429/5xx/529 are retried with backoff, truncated answers are retried with a larger budget, refusals surface as typed errors, and every system prompt carries an English-only rule.

Tests: `bun run test:models` (model gate, 53 checks), `bun run test:llm` (offline mock of the Messages API, 27 checks), `bun scripts/test-frontier-families.ts` and `bun scripts/test-frontier-radar.ts` (need `bunx prisma generate`; the radar test also needs the dev DB).

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Dev server on port 3000 (output tee'd to `dev.log`) |
| `bun run build` | Production build (standalone output) |
| `bun run lint` | ESLint over the repo |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:push` | `prisma db push --accept-data-loss` |

Highlights from `scripts/` (all against the dev server on :3000):

- `node scripts/hunt-live.mjs <phase>` — live population run: `token` (store a PAT server-side), `hunt` (start/resume a live hunt to done), `harvest` (autonomous elite-repo harvest), `sweep` (full deep sweep, polled to done), `status` (DB summary)
- `node scripts/dna-snapshot.mjs` — export all non-secret hunter tables to `reports/state/dna-snapshot.json`
- `node scripts/dna-restore.mjs` — reseed the DB from that snapshot after an environment recycle
- `bun scripts/e2e-round6.ts <phase>` — live end-to-end verification: `search`, `hunt`, `report-cas` (lost-update test), `fail-inject`, `sweep`, `audit`, `assert`
- `node scripts/run-gen7.mjs` — start a live hunt and pump stages until done
- `node scripts/chimera-live.mjs [topN]` — synthesize a chimera from the top DNA-rich repos
- `node scripts/audit-dna-quality.mjs` — DNA library quality audit (size distribution, misclassifications, duplicates, field DNA)
- `node scripts/purge-non-english.mjs [snapshot] [--dry]` — removes self-generated non-English rows from the snapshot (third-party mined files are never touched)

## Documentation

The full engineering history lives in [`reports/evolution/`](./reports/evolution/) — audit rounds 2-7, hunt-generation logs (gen 1-6) and chimera breakdowns, each with verification evidence. These are historical documents, originally written in Hebrew, and are kept as-is for provenance.

---

This hunting tool is the equipment — it is not the one making the decisions.
