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
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { emitSnapshot } from "./event-bus";

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

// round 8: four subsystems (sweep stage-D, hunt verdict, harvest, synthesis) fire
// writeDnaSnapshot() fire-and-forget with NO lock — two overlapping writers opened the
// SAME `.tmp` with O_TRUNC, interleaved writes, and the slow writer's rename hit ENOENT:
// the merged final file failed JSON.parse ("Unexpected non-whitespace character after JSON")
// — and dna-restore.mjs parses it unguarded, so disaster recovery would hard-fail exactly
// when the recycle strikes. Two-part fix: (1) a unique tmp name per writer — two writers
// can never touch the same partial file; (2) an in-process promise queue — one writer at
// a time per process (each Next.js worker), so the tmp dance is fully serialized.
let snapshotQueueTail: Promise<void> = Promise.resolve();

// ---------- digest-skip: don't rewrite 20MB when nothing changed ----------

// Four subsystems (sweep stage-D, hunt verdict, harvest, synthesis) fire
// writeDnaSnapshot() at every growth moment — and most of those moments find
// the library IDENTICAL to the last write (overlapping events inside one
// hunt, a verdict that mined nothing new). Each no-op rewrite re-reads seven
// tables, re-stringifies ~20MB and rewrites the file for nothing.
// The digest fingerprints what WOULD be serialized using SQL aggregates only
// — per-table count + max id + max createdAt/updatedAt — plus a sha1 of each
// learning row's value: zero rows are ever loaded just to decide. The three
// createdAt-only tables (DnaArtifact / Chimera / SearchHistory) are append-only
// in practice — nothing in the app updates their rows in place — so count +
// maxId + maxCreatedAt is change-complete for them; the four tables carrying
// @updatedAt also fold in their freshest update timestamp, so an in-place edit
// (score, status, stage) moves the digest too.
// NOTE: the same-second write guard suggested in the v0.5 plan is deliberately
// NOT layered on top — the digest already kills the identical-rewrite case,
// and a time-based guard would also skip a LEGITIMATE write when two real
// growth events land inside one second (mine + verdict of the same hunt),
// leaving the snapshot missing the second event exactly when a recycle could
// strike. The memo updates only AFTER a successful rename, so a failed write
// is retried by the next caller.
let lastSnapshotDigest: string | null = null;

/** sha1 over per-table aggregates + learning values — one aggregate round-trip,
 *  zero row loads, cheap enough to run on every snapshot attempt. */
async function computeSnapshotDigest(): Promise<string> {
  const [dna, repos, chimeras, missions, hunts, sweeps, history, learningRows] = await Promise.all([
    db.dnaArtifact.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true } }),
    db.savedRepo.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true, updatedAt: true } }),
    db.chimera.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true } }),
    db.mission.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true, updatedAt: true } }),
    db.liveHunt.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true, updatedAt: true } }),
    db.sweepRun.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true, updatedAt: true } }),
    db.searchHistory.aggregate({ _count: { _all: true }, _max: { id: true, createdAt: true } }),
    db.setting.findMany({ where: { key: { in: [...LEARNING_KEYS] } } }),
  ]);
  const part = (
    name: string,
    count: number,
    maxId: number | null,
    maxCreated: Date | null,
    maxUpdated: Date | null
  ) => `${name}:${count}:${maxId ?? -1}:${maxCreated ? maxCreated.getTime() : -1}:${maxUpdated ? maxUpdated.getTime() : -1}`;
  const learning = learningRows
    .map((r) => `${r.key}=${createHash("sha1").update(r.value).digest("hex")}`)
    .sort()
    .join("|");
  return createHash("sha1")
    .update(
      [
        part("dnaArtifacts", dna._count._all, dna._max.id, dna._max.createdAt, null),
        part("savedRepos", repos._count._all, repos._max.id, repos._max.createdAt, repos._max.updatedAt),
        part("chimeras", chimeras._count._all, chimeras._max.id, chimeras._max.createdAt, null),
        part("missions", missions._count._all, missions._max.id, missions._max.createdAt, missions._max.updatedAt),
        part("liveHunts", hunts._count._all, hunts._max.id, hunts._max.createdAt, hunts._max.updatedAt),
        part("sweepRuns", sweeps._count._all, sweeps._max.id, sweeps._max.createdAt, sweeps._max.updatedAt),
        part("searchHistory", history._count._all, history._max.id, history._max.createdAt, null),
        `learning:${learning}`,
      ].join("\n")
    )
    .digest("hex");
}

/**
 * Read the gene count recorded in the EXISTING snapshot file without parsing
 * 20MB: `counts.dnaArtifacts` sits near the top of the document in both this
 * module and the manual script (indent-1 pretty JSON, counts first). A 4KB
 * head + regex covers both writers; a miss returns null (no guard opinion).
 */
async function readSnapshotGeneCount(target: string): Promise<number | null> {
  try {
    const { open } = await import("node:fs/promises");
    const fh = await open(target, "r");
    try {
      const head = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(head, 0, 4096, 0);
      const text = head.subarray(0, bytesRead).toString("utf8");
      const m = text.match(/"dnaArtifacts"\s*:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null; // no existing file (or unreadable) — nothing to protect
  }
}

export async function writeDnaSnapshot(): Promise<void> {
  const run = snapshotQueueTail.then(() => writeDnaSnapshotNow());
  // the chain swallows a failure so the NEXT writer still runs — the CALLER
  // gets the real outcome via `run` (all four callers attach .catch(console.error))
  snapshotQueueTail = run.catch(() => {});
  return run;
}
async function writeDnaSnapshotNow(): Promise<void> {
  const stateDir = path.join(process.cwd(), "reports", "state");
  const target = path.join(stateDir, "dna-snapshot.json");

  // digest-skip — decide BEFORE the heavy read: the common case (overlapping
  // growth events, unchanged library) never loads a single row. The file's
  // existence is re-checked too: if something external deleted the snapshot,
  // an "unchanged" memo must not leave disaster recovery fileless.
  const digest = await computeSnapshotDigest();
  if (digest === lastSnapshotDigest) {
    let fileExists = true;
    try {
      await access(target);
    } catch {
      fileExists = false;
    }
    if (fileExists) {
      emitSnapshot({ written: false, note: "unchanged — skipped" });
      return;
    }
  }

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

  const json = JSON.stringify(snapshot, null, 1);

  // ---------- regression ratchet (v0.4.0) ----------
  // The disaster-recovery file must never be DESTROYED by the very mechanism
  // that's supposed to protect it. Real incident (2026-11-14, integration day):
  // the environment recycled and wiped the DB to zero rows; a growth-event
  // snapshot then fired against the EMPTY DB and overwrote the 20MB / 1750-gene
  // snapshot with an empty dump — disaster recovery would have "recovered"
  // nothing. Git saved the file (it's tracked); the guard belongs in code.
  // Rule: an automatic snapshot may not shrink the recorded gene count below
  // half of what the existing snapshot holds (when the old file holds ≥ 200
  // genes). A deliberate wipe still has its path: the manual script
  // (scripts/dna-snapshot.mjs) writes without this guard — a human decision.
  const newGenes = snapshot.counts.dnaArtifacts;
  const oldGenes = await readSnapshotGeneCount(target);
  if (oldGenes !== null && oldGenes >= 200 && newGenes < Math.floor(oldGenes / 2)) {
    console.error(
      `[dna-snapshot] REGRESSION BLOCKED — refusing to overwrite a ${oldGenes}-gene snapshot with ${newGenes} genes (the DB looks wiped/recycled). Restore first: node scripts/dna-restore.mjs — or run the manual snapshot script to force.`,
    );
    emitSnapshot({
      written: false,
      note: `regression blocked — kept the ${oldGenes}-gene snapshot (DB holds only ${newGenes})`,
    });
    return;
  }

  // unique per writer (pid + uuid): concurrent writers can never share a partial file
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(tmp, json, "utf8");
  // Atomic swap — a reader (the restore script, git) never sees a half-written snapshot
  try {
    await rename(tmp, target);
  } catch (e) {
    // best-effort cleanup of OUR partial file — never leave orphans in reports/state
    console.error("[dna-snapshot] rename failed:", e);
    try { await import("node:fs/promises").then((fs) => fs.rm(tmp, { force: true })); } catch { /* tmp already gone */ }
    throw e;
  }
  // the memo is updated only AFTER the rename succeeded — a failed write must
  // be retried by the next caller, not mistaken for done
  lastSnapshotDigest = digest;
  emitSnapshot({ written: true, note: `${Buffer.byteLength(json, "utf8")} bytes` });
}
