#!/usr/bin/env node
/**
 * dna-snapshot.mjs — export all non-secret hunter tables to reports/state/dna-snapshot.json
 * WHY: the sandbox environment recycles between sessions and wipes db/custom.db
 *      (this exact wipe killed the harvest data twice). The snapshot lives in git,
 *      so the library survives any recycle; restore with scripts/dna-restore.mjs.
 * SAFETY: only public intelligence is exported (DNA mined from public repos,
 *         hunts, missions, sweeps, chimera). From the Setting table ONLY the three
 *         learning keys (mineAttempts, queryYieldStats, frontierLedger) are exported — never the
 *         GitHub PAT.
 * Usage: node scripts/dna-snapshot.mjs
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

const db = new PrismaClient();

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

function cleanArtifact(a) {
  return { ...a, createdAt: iso(a.createdAt) };
}

try {
  const [artifacts, savedRepos, chimeras, missions, hunts, sweeps, history, learningRows] = await Promise.all([
    db.dnaArtifact.findMany({ orderBy: { id: "asc" } }),
    db.savedRepo.findMany({ orderBy: { id: "asc" } }),
    db.chimera.findMany({ orderBy: { id: "asc" } }),
    db.mission.findMany({ orderBy: { id: "asc" } }),
    db.liveHunt.findMany({ orderBy: { id: "asc" } }),
    db.sweepRun.findMany({ orderBy: { id: "asc" } }),
    db.searchHistory.findMany({ orderBy: { id: "asc" } }),
    db.setting.findMany({ where: { key: { in: ["mineAttempts", "queryYieldStats", "frontierLedger"] } } }),
  ]);

  // Learning state (v1.1) — same keys the in-app writer exports; a recycle must
  // not reset the empty-mine memory or the query yield ledger.
  const learningState = {};
  for (const row of learningRows) {
    try { learningState[row.key] = JSON.parse(row.value); } catch { /* skip corrupted */ }
  }

  const snapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      dnaArtifacts: artifacts.length,
      savedRepos: savedRepos.length,
      chimeras: chimeras.length,
      missions: missions.length,
      liveHunts: hunts.length,
      sweepRuns: sweeps.length,
      searchHistory: history.length,
    },
    learningState,
    // date fields → ISO strings so the JSON is fully deterministic
    dnaArtifacts: artifacts.map(cleanArtifact),
    savedRepos: savedRepos.map((r) => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })),
    chimeras: chimeras.map((c) => ({ ...c, createdAt: iso(c.createdAt) })),
    missions: missions.map((m) => ({
      ...m,
      createdAt: iso(m.createdAt),
      updatedAt: iso(m.updatedAt),
      steps: m.steps, // already JSON string
    })),
    liveHunts: hunts.map((h) => ({ ...h, createdAt: iso(h.createdAt), updatedAt: iso(h.updatedAt) })),
    sweepRuns: sweeps.map((s) => ({ ...s, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) })),
    searchHistory: history.map((h) => ({ ...h, createdAt: iso(h.createdAt) })),
  };

  // round 8: a single-shot writeFileSync of the ~20MB snapshot — the ONE event this
  // system is built around (the env recycle killing processes mid-run) could truncate
  // it mid-write, and a truncated snapshot then chained into restore crashes and
  // bypassed never-regress guards downstream. tmp + rename (atomic on POSIX), with a
  // pid+uuid tmp name so this script can never share a partial file with the in-app
  // writer (which uses the same discipline with its own unique tmp).
  mkdirSync("reports/state", { recursive: true });
  const tmp = `reports/state/dna-snapshot.json.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1), "utf8");
  renameSync(tmp, "reports/state/dna-snapshot.json");
  console.log(`SNAPSHOT_OK | genes=${artifacts.length} repos=${savedRepos.length} chimeras=${chimeras.length} missions=${missions.length} hunts=${hunts.length} sweeps=${sweeps.length} history=${history.length}`);
  console.log("  → reports/state/dna-snapshot.json (commit this to survive env recycles)");
} catch (e) {
  console.error("SNAPSHOT_FAIL:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
