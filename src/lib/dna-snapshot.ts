// ============================================================
// Automatic DNA snapshots — the in-app twin of scripts/dna-snapshot.mjs.
// WHY: the sandbox environment recycles between sessions and wipes db/custom.db
// (this exact wipe killed the harvest data twice). Until now the snapshot was
// manual-only — a script a human had to remember to run after every growth
// event, and the library survived only if they did. Now the app writes the
// snapshot itself at every library-growth moment (live-hunt verdict, sweep mine
// phase, chimera synthesis, manual harvest) — always fire-and-forget, so
// snapshot I/O can never block or fail the parent flow.
// SAFETY: identical v1 shape to the script's output, because
// scripts/dna-restore.mjs reads exactly these keys after a recycle — any drift
// here silently breaks disaster recovery. Only public intelligence tables are
// exported; from the Setting table ONLY the two learning keys (mineAttempts,
// queryYieldStats) are read — the GitHub PAT never enters a snapshot.
// Atomic write: tmp file + fs.rename — a crash mid-write can never leave a
// truncated snapshot that dna-restore.mjs would then seed into a fresh DB.
// Server-side only.
// ============================================================

import { db } from "./db";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Date → ISO string, so the JSON is fully deterministic (same normalization the script does) */
const iso = (d: Date) => d.toISOString();

/**
 * Export all non-secret hunter tables to reports/state/dna-snapshot.json.
 * Produces the same document as `node scripts/dna-snapshot.mjs` — v1, exportedAt,
 * counts, and the seven table arrays with dates as ISO strings.
 */
/** The non-secret Setting keys that must survive a recycle — the hunter's
 * learned state. Anything else in Setting (the PAT) stays out on purpose.
 * v1.2: frontierLedger joins — without it every recycle reset the emerging-model
 * radar to zero, and the next model release would lose its accumulated evidence. */
const LEARNING_KEYS = ["mineAttempts", "queryYieldStats", "frontierLedger"] as const;

export async function writeDnaSnapshot(): Promise<void> {
  // All seven public tables in one parallel round — same reads the script does,
  // minus the rest of the Setting table on purpose (the PAT never enters a snapshot).
  const [artifacts, savedRepos, chimeras, missions, hunts, sweeps, history, learningRows] = await Promise.all([
    db.dnaArtifact.findMany({ orderBy: { id: "asc" } }),
    db.savedRepo.findMany({ orderBy: { id: "asc" } }),
    db.chimera.findMany({ orderBy: { id: "asc" } }),
    db.mission.findMany({ orderBy: { id: "asc" } }),
    db.liveHunt.findMany({ orderBy: { id: "asc" } }),
    db.sweepRun.findMany({ orderBy: { id: "asc" } }),
    db.searchHistory.findMany({ orderBy: { id: "asc" } }),
    db.setting.findMany({ where: { key: { in: [...LEARNING_KEYS] } } }),
  ]);
  // Learning state (v1.1): empty-mine memory + query yield ledger. Without this,
  // every recycle reset the adaptive learning to zero — blocked sterile repos got
  // re-mined (wasted quota) and the yield ranking restarted from amnesia.
  const learningState: Record<string, unknown> = {};
  for (const row of learningRows) {
    try {
      learningState[row.key] = JSON.parse(row.value);
    } catch {
      // a corrupted row is skipped — the snapshot must never fail on it
    }
  }

  // The v1 shape, key for key with the script (missions: the script also spreads a
  // `steps` field that doesn't exist on the model — JSON.stringify drops undefined,
  // so omitting it here yields byte-identical output).
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
    dnaArtifacts: artifacts.map((a) => ({ ...a, createdAt: iso(a.createdAt) })),
    savedRepos: savedRepos.map((r) => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })),
    chimeras: chimeras.map((c) => ({ ...c, createdAt: iso(c.createdAt) })),
    missions: missions.map((m) => ({ ...m, createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt) })),
    liveHunts: hunts.map((h) => ({ ...h, createdAt: iso(h.createdAt), updatedAt: iso(h.updatedAt) })),
    sweepRuns: sweeps.map((s) => ({ ...s, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) })),
    searchHistory: history.map((h) => ({ ...h, createdAt: iso(h.createdAt) })),
  };

  const stateDir = path.join(process.cwd(), "reports", "state");
  const target = path.join(stateDir, "dna-snapshot.json");
  const tmp = `${target}.tmp`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(tmp, JSON.stringify(snapshot, null, 1), "utf8");
  // Atomic swap — a reader (the restore script, git) never sees a half-written snapshot
  await rename(tmp, target);
}
