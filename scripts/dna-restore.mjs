#!/usr/bin/env node
/**
 * dna-restore.mjs — reseed db/custom.db from reports/state/dna-snapshot.json
 * Runs after an environment recycle wiped the DB (the recurring data loss).
 * Idempotent: upsert by natural key; running twice adds nothing.
 * The GitHub PAT is NOT in the snapshot — re-store it with:
 *   node scripts/hunt-live.mjs token
 * Usage: node scripts/dna-restore.mjs
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";

const db = new PrismaClient();
const FILE = "reports/state/dna-snapshot.json";

if (!existsSync(FILE)) {
  console.error("NO_SNAPSHOT | run a live population first, then scripts/dna-snapshot.mjs");
  process.exit(1);
}

// round 8: this parse sat BEFORE the try — a corrupt/partial snapshot crashed with a
// raw SyntaxError + stack trace, the friendly RESTORE_FAIL path never ran, and db.$disconnect()
// in the finally was skipped. The parse is inside the try now.
let snap;
try {
  snap = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  console.error("RESTORE_FAIL | snapshot unreadable (corrupt or partially written):", e.message);
  process.exit(1);
}
const dt = (s) => (s ? new Date(s) : new Date());

try {
  // 1) SavedRepo (watchlist) — natural key fullName
  let repos = 0;
  for (const r of snap.savedRepos ?? []) {
    await db.savedRepo.upsert({
      where: { fullName: r.fullName },
      create: {
        fullName: r.fullName,
        owner: r.owner,
        name: r.name,
        url: r.url,
        description: r.description,
        stars: r.stars,
        score: r.score,
        models: r.models,
        evidence: r.evidence,
        license: r.license ?? null,
        notes: r.notes,
        createdAt: dt(r.createdAt),
      },
      update: {
        score: r.score,
        stars: r.stars,
        notes: r.notes,
        // round 8: the update branch never restored these — a partially-populated DB
        // (rows exist, licenses/models null) stayed stale even though the snapshot held
        // the backfilled values; only a later license-backfill healed genes, never watchlist
        license: r.license ?? null,
        models: r.models,
        evidence: r.evidence,
        description: r.description,
      },
    });
    repos++;
  }

  // 2) DnaArtifact — natural key (sourceRepo, path) + EXPLICIT id preservation.
  // Field-fact why ids matter (2026-11-13): mission.dnaRefs references gene ids. The
  // old restore created genes WITHOUT ids, so ids survived only while the table was
  // contiguous 1..N — any future deletion (quality purge, fiction purge) would make
  // every restore renumber the table and silently point dnaRefs at the WRONG genes.
  // Explicit ids make the mapping structural, not coincidental.
  // round 8 P2002 guard: the upsert matched by natural key but CREATED with the explicit
  // snapshot id — on a partially re-grown DB (any hunt/harvest ran before restore; the
  // app auto-mines eagerly) a new gene already occupied that id at a DIFFERENT (repo,path)
  // → primary-key collision → RESTORE_FAIL mid-loop, earlier rows committed, later rows
  // skipped. Now: id-first (heal), natural-key second (update), create only when neither
  // exists — and the update branch restores the fields it never touched.
  // round 11 parity with src/lib/dna-restore.ts: an id collision with a DIFFERENT
  // re-grown gene is no longer a SKIP — the gene is RE-HOMED under a fresh
  // autoincrement id when its natural key is free. Field fact (2026-11-14): the
  // recycle re-grew 64 genes at ids 1..64 and this script skipped 62 snapshot
  // genes forever — their content sat in the snapshot file but never re-entered
  // the live library. Re-homing returns the content (search, compilation, export);
  // stale id refs dangle either way (the gene was absent under that id).
  let genes = 0;
  let geneIdSkips = 0;
  let geneIdRehomed = 0;
  for (const a of snap.dnaArtifacts ?? []) {
    const byId = await db.dnaArtifact.findUnique({ where: { id: a.id } });
    if (byId) {
      if (byId.sourceRepo === a.sourceRepo && byId.path === a.path) {
        // same gene, partially populated — heal the fields restore never touched
        await db.dnaArtifact.update({
          where: { id: a.id },
          data: {
            content: a.content,
            description: a.description,
            size: a.size,
            license: a.license ?? null,
            name: a.name,
            kind: a.kind,
            rawUrl: a.rawUrl,
          },
        });
        genes++;
        continue;
      }
      // id occupied by a DIFFERENT gene (post-wipe regrowth) — try to re-home the
      // snapshot gene under a fresh id; only if even its natural key is taken is it
      // truly a duplicate (already re-grown) and may be skipped
      const byKey = await db.dnaArtifact.findUnique({
        where: { sourceRepo_path: { sourceRepo: a.sourceRepo, path: a.path } },
      });
      if (!byKey) {
        await db.dnaArtifact.create({
          data: {
            sourceRepo: a.sourceRepo,
            path: a.path,
            kind: a.kind,
            name: a.name,
            description: a.description,
            content: a.content,
            rawUrl: a.rawUrl,
            size: a.size,
            license: a.license ?? null,
            createdAt: dt(a.createdAt),
          },
        });
        geneIdRehomed++;
        genes++;
        continue;
      }
      geneIdSkips++;
      console.warn(`  gene id ${a.id} (${a.sourceRepo}/${a.path}) already present under id ${byKey.id} — skipped as duplicate`);
      continue;
    }
    await db.dnaArtifact.upsert({
      where: { sourceRepo_path: { sourceRepo: a.sourceRepo, path: a.path } },
      create: {
        id: a.id,
        sourceRepo: a.sourceRepo,
        path: a.path,
        kind: a.kind,
        name: a.name,
        description: a.description,
        content: a.content,
        rawUrl: a.rawUrl,
        size: a.size,
        license: a.license ?? null,
        createdAt: dt(a.createdAt),
      },
      update: {
        content: a.content,
        description: a.description,
        size: a.size,
        license: a.license ?? null,
        name: a.name,
        kind: a.kind,
        rawUrl: a.rawUrl,
      },
    });
    genes++;
  }

  // 3) Chimera — EXPLICIT id preservation + id-first dedupe, name+sources as the
  // natural-key fallback. Field fact (2026-11-13): chimeras #4 and #5 are BOTH named
  // elite-parallel-orchestrator (independent syntheses converged on the same kebab
  // name) — a name-only check silently dropped #5 on every restore, and its frontier
  // DNA + truth-gate patch vanished with it. Id-first dedupe makes the record
  // identity structural regardless of naming collisions.
  let chimeras = 0;
  for (const c of snap.chimeras ?? []) {
    const byId = await db.chimera.findUnique({ where: { id: c.id } });
    if (byId) continue;
    const byKey = await db.chimera.findFirst({ where: { name: c.name, sources: c.sources } });
    if (byKey && byKey.id !== c.id) continue; // same creature re-created under a new id — keep the existing row
    await db.chimera.create({
      data: {
        id: c.id,
        name: c.name,
        oneLiner: c.oneLiner,
        sources: c.sources,
        skillMd: c.skillMd,
        principles: c.principles,
        workOrders: c.workOrders,
        breakthrough: c.breakthrough,
        createdAt: dt(c.createdAt),
      },
    });
    chimeras++;
  }

  // 4) Mission — EXPLICIT id preservation + id-first dedupe. Field fact
  // (2026-11-13): mission names are LLM codenames — a repeat name across
  // generations is plausible, and the old name-only dedupe silently dropped the
  // whole mission on every restore (the same loss class that ate chimera #5).
  // hunt.missionId and mission.dnaRefs both reference these ids — they must be
  // structural, not coincidental.
  let missions = 0;
  for (const m of snap.missions ?? []) {
    const byId = await db.mission.findUnique({ where: { id: m.id } });
    if (byId) continue;
    await db.mission.create({
      data: {
        id: m.id,
        goal: m.goal,
        context: m.context,
        status: m.status,
        missionName: m.missionName,
        plan: m.plan,
        dnaRefs: m.dnaRefs,
        promptSequence: m.promptSequence,
        skillMd: m.skillMd,
        risks: m.risks,
        successCriteria: m.successCriteria,
        report: m.report,
        autopilot: m.autopilot,
        autopilotAt: m.autopilotAt ? dt(m.autopilotAt) : null,
        createdAt: dt(m.createdAt),
      },
    });
    missions++;
  }

  // 5) LiveHunt — id-preserving recreate (history integrity)
  let hunts = 0;
  for (const h of snap.liveHunts ?? []) {
    const existing = await db.liveHunt.findUnique({ where: { id: h.id } });
    if (existing) continue;
    await db.liveHunt.create({
      data: {
        id: h.id,
        status: h.status,
        stageKey: h.stageKey,
        stages: h.stages,
        goal: h.goal,
        missionId: h.missionId,
        generation: h.generation,
        seededFrom: h.seededFrom,
        dnaBefore: h.dnaBefore,
        dnaAfter: h.dnaAfter,
        llmCalls: h.llmCalls,
        elapsedMs: h.elapsedMs,
        error: h.error,
        createdAt: dt(h.createdAt),
      },
    });
    hunts++;
  }

  // 6) SweepRun — id-preserving recreate, with one honesty fix: a snapshot row
  //    captured MID-RUN (status "running") describes a process that died with the
  //    server — no executeSweep loop survives a recycle. Restoring it as "running"
  //    is a GHOST that blocks new sweeps (409) for up to 15 minutes after the
  //    restore (Prisma stamps a fresh updatedAt, the reaper clock restarts).
  //    Restored as failed — same law the crash-recovery reaper applies.
  //    (LiveHunt rows stay as-is: hunts ARE resumable — the scheduler's
  //    orphan-takeover continues them by design.)
  let sweeps = 0;
  for (const s of snap.sweepRuns ?? []) {
    const existing = await db.sweepRun.findUnique({ where: { id: s.id } });
    if (existing) continue;
    const wasRunning = s.status === "running";
    await db.sweepRun.create({
      data: {
        id: s.id,
        status: wasRunning ? "failed" : s.status,
        phase: s.phase,
        progress: s.progress,
        queries: s.queries,
        stats: s.stats,
        findings: s.findings,
        briefing: s.briefing,
        audit: s.audit,
        error: wasRunning
          ? "The run was interrupted (the server was recycled mid-run) — restored as failed by the restore"
          : s.error,
        createdAt: dt(s.createdAt),
      },
    });
    sweeps++;
  }

  // 7) SearchHistory — recreate all (natural key: none; count-guard by first row)
  let history = 0;
  const histCount = await db.searchHistory.count();
  if (histCount === 0) {
    for (const h of snap.searchHistory ?? []) {
      await db.searchHistory.create({
        data: {
          mode: h.mode,
          query: h.query,
          filters: h.filters,
          resultCount: h.resultCount,
          createdAt: dt(h.createdAt),
        },
      });
      history++;
    }
  }

  // 8) Learning state (v1.1 snapshots) — the empty-mine memory + query yield
  //    ledger. Only fills MISSING rows: on a wiped DB they're gone (the normal
  //    post-recycle case); on a live DB the newer state wins (never clobbered).
  //    Old snapshots without learningState simply skip — backward compatible.
  let learning = 0;
  for (const key of ["mineAttempts", "queryYieldStats", "frontierLedger"]) {
    const val = snap.learningState?.[key];
    if (val === undefined || val === null) continue;
    const existing = await db.setting.findUnique({ where: { key } });
    if (existing) continue;
    await db.setting.create({ data: { key, value: JSON.stringify(val) } });
    learning++;
  }

  console.log(
    `RESTORE_OK | repos=${repos} genes=${genes}${geneIdSkips ? ` geneIdSkips=${geneIdSkips}` : ""}${geneIdRehomed ? ` geneIdRehomed=${geneIdRehomed}` : ""} chimeras=${chimeras} missions=${missions} hunts=${hunts} sweeps=${sweeps} history=${history} learning=${learning}`,
  );
  const total = await db.dnaArtifact.count();
  console.log(`  library now: ${total} genes`);
} catch (e) {
  console.error("RESTORE_FAIL:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
