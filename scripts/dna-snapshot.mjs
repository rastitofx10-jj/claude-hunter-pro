#!/usr/bin/env node
/**
 * dna-snapshot.mjs — export all non-secret hunter tables to reports/state/dna-snapshot.json
 * WHY: the sandbox environment recycles between sessions and wipes db/custom.db
 *      (this exact wipe killed the harvest data twice). The snapshot lives in git,
 *      so the library survives any recycle; restore with scripts/dna-restore.mjs.
 * SAFETY: only public intelligence is exported (DNA mined from public repos,
 *         hunts, missions, sweeps, chimera). The Setting table (GitHub PAT)
 *         is NEVER exported.
 * Usage: node scripts/dna-snapshot.mjs
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";

const db = new PrismaClient();

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

function cleanArtifact(a) {
  return { ...a, createdAt: iso(a.createdAt) };
}

try {
  const [artifacts, savedRepos, chimeras, missions, hunts, sweeps, history] = await Promise.all([
    db.dnaArtifact.findMany({ orderBy: { id: "asc" } }),
    db.savedRepo.findMany({ orderBy: { id: "asc" } }),
    db.chimera.findMany({ orderBy: { id: "asc" } }),
    db.mission.findMany({ orderBy: { id: "asc" } }),
    db.liveHunt.findMany({ orderBy: { id: "asc" } }),
    db.sweepRun.findMany({ orderBy: { id: "asc" } }),
    db.searchHistory.findMany({ orderBy: { id: "asc" } }),
  ]);

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

  mkdirSync("reports/state", { recursive: true });
  writeFileSync("reports/state/dna-snapshot.json", JSON.stringify(snapshot, null, 1), "utf8");
  console.log(`SNAPSHOT_OK | genes=${artifacts.length} repos=${savedRepos.length} chimeras=${chimeras.length} missions=${missions.length} hunts=${hunts.length} sweeps=${sweeps.length} history=${history.length}`);
  console.log("  → reports/state/dna-snapshot.json (commit this to survive env recycles)");
} catch (e) {
  console.error("SNAPSHOT_FAIL:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
