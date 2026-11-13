# Claude Hunter — Round 7: The Silent-Duplication Audit (2026-11-13)

**Mandate (user, Hebrew):** "אז בחן עוד יותר בטח יש עוד המון"
— keep examining deeper; surely there are many more [defects of the same class].

**Method:** a systematic hunt for the family that produced the day's first three
bugs (restore dropping chimera #5 on a name collision; the platform auto-snapshot
racing a truth patch; three chimeras born with one name). The family signature:
**records that collide or renumber silently, and tools that verify the wrong
thing.** Every check was run against the live DB and the committed snapshot.

---

## 1. Findings

### 1.1 Latent id-drift: genes and missions restored WITHOUT explicit ids (HIGH, latent)
`dna-restore.mjs` recreated hunts and sweeps id-preserving, but genes and missions
relied on autoincrement numbering into an empty table. Today's ids are contiguous
1..N **by coincidence** — the first future deletion (quality purge, fiction purge)
would make every restore silently renumber the table, and `mission.dnaRefs`
(gene-id references) would point at the WRONG genes with no error anywhere.
**Fix:** explicit id preservation + id-first dedupe for genes, missions, chimeras.
**Proof (live deletion simulation):** gene #843 and mission #18 deleted from the
DB, restore re-run — both returned with their EXACT ids, total 1,752/1,752.

### 1.2 Mission dedupe by LLM codename (MEDIUM, latent)
Mission names are LLM-generated codenames — a repeat across generations is
plausible, and the name-only dedupe would silently drop the whole mission (the
exact loss class that ate chimera #5). **Fix:** id-first dedupe (name kept only
as display). Today's 30 mission names verified unique — but the trap is disarmed
structurally now.

### 1.3 verify-remote-head.mjs verified the WRONG thing (MEDIUM, live)
The tool queried `commits?path=reports/evolution/hunt-gen4.md` — a path-scoped
file history — and printed its newest entry as if it were the branch head. While
the real remote head was `9b909b5`, it reported `c631cf4`. A verification tool
that lies with an authoritative face is worse than none. **Fix:** queries
`/branches/main`, diffs against local `git rev-parse HEAD`, exit code 1 on
divergence. Now reports the truth: remote 9b909b5 = local 9b909b5, inSync.

### 1.4 A third of the hunt budget burned on stale model strings (HIGH, live — device directive)
The sweep arsenal spent **20 of 72 queries per run** on nine old-model strings
(claude-3-haiku, claude-3-opus, sonnet-4, opus-4-1…) — corners whose result set
is historically fixed. The harvest's daily rotation landed on claude-3-era
strings for entire days. The Genesis UI copy already claimed "real-frontier code
searches (opus-4-5 · sonnet-4-5 · haiku-4-5)" — the copy was aspirational.
**Fix (frontierModels() selector in the truth registry):** only models AT each
family's real frontier generate hunt queries. Old registry models keep full
DETECTION and SCORING roles in found repos — they just never steer the hunt
budget again. The frontier line tracks the registry automatically when a real
new version lands. Arsenal after: **38 static queries, 0 old-model queries,
28% of the budget freed** for frontier rotation and confirmed-wave hunting.

### 1.5 Variable shadowing in deep-sweep.ts (LOW)
The local `frontierModels` const (wave-evidence lookup) shadowed the newly
imported `frontierModels()` selector — legal TypeScript, lethal to a future
reader. Renamed to `waveProofModels`.

## 2. Checks that came back clean (the negative results are part of the record)

- **Mission name duplicates in snapshot:** none (30/30 unique — verified, not assumed)
- **mission.dnaRefs integrity:** every referenced gene id exists (30 missions scanned)
- **hunt.missionId integrity:** every referenced mission exists
- **Gene/mission/chimera id contiguity:** 1..N no gaps (today; the fix removes the dependency on this luck)
- **frontierLedger persistence:** snapshotted in learningState, restored, 3 authority-confirmed waves intact
- **Live sweep query origins:** registry real trio + capability + market + topic + frontier pools + confirmed waves only — zero fiction strings executed (the 3 regex-flagged "fiction" hits were the authority-CONFIRMED opus-5-5 wave itself)
- **audit-queries.mjs "fiction" output:** false alarm — it prints gen-4's HISTORICAL hunt evidence (the fiction-era record that motivated the truth migration), runs no live queries
- **test-model-gate-adversarial.mjs fable references:** intentional — the adversarial test asserting fiction is rejected
- **UI chimera resolution:** by object + id (`key={c.id}`, `setChimera(c)`), not by name — collision-safe
- **{fresh} placeholder:** hydrated at every live consumption point (deep-sweep, harvester, emerging-models feed)
- **Adaptive-learning yield stats:** dead old-model query stats persist but can never rank again (harmless)

## 3. The day's bug-family census (rounds 5–7 combined)

All six defects found today share one signature — **identity that is not
structural**: dedupe by mutable name instead of id, ids that survive only while
tables stay contiguous, verification that checks a proxy instead of the thing.
The fixes make identity structural everywhere: explicit id preservation in the
restore, id-first dedupe, name-collision guard at synthesis (ban + inject +
suffix), and a head-verification tool that actually fetches the head.

---
*Verified: lint 0 errors (1 pre-existing warning), deletion-simulation restore
exact-id 2/2, arsenal census 0 old-model queries, remote head verified in-sync.*
