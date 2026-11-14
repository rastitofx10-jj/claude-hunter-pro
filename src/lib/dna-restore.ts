// ============================================================
// The library's self-healing twin of scripts/dna-restore.mjs.
//
// Field fact (2026-11-14, twice in one day): the sandbox recycles and wipes
// db/custom.db. The regression ratchet in dna-snapshot.ts correctly REFUSED
// to overwrite the 1849-gene snapshot with the 64-gene re-grown DB — and
// then did nothing else. The DB stayed near-empty (a near-fabricated
// "evolutionary library") until a human happened to run the restore script.
// The guard detected the disease; only a human could administer the cure.
//
// This module closes that loop: the app now heals ITSELF.
//   - boot (instrumentation.ts): looksWiped() → auto-restore, fire-and-forget
//   - the regression ratchet itself (dna-snapshot.ts): the moment it detects
//     a wiped DB it fires the same auto-restore instead of only logging
//
// Parity contract with scripts/dna-restore.mjs: identical v1 snapshot shape,
// identical table order (repos → genes → chimeras → missions → hunts →
// sweeps → history → learning), id-first dedupe, natural-key fallback — plus
// ONE deliberate improvement both twins share: a snapshot gene whose id is
// occupied by a DIFFERENT re-grown gene is RE-HOMED under a fresh
// autoincrement id (when its natural key is free) instead of skipped.
// Field fact: the 2026-11-14 recycle re-grew 64 genes at ids 1..64; the old
// script skipped 62 snapshot genes forever — their content sat in the
// snapshot file but never again entered the live library.
//
// Idempotent by construction: every step upserts or checks-before-create.
// Server-side only.
// ============================================================

import { db } from "./db";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { emitDnaBorn, emitAutonomy } from "./event-bus";

const SNAPSHOT_FILE = path.join("reports", "state", "dna-snapshot.json");
const dt = (s: string | null | undefined) => (s ? new Date(s) : new Date());

/** Same wipe bar as the regression ratchet (dna-snapshot.ts): a snapshot with
 *  ≥ 200 genes vs a DB under half of it = the DB looks wiped/recycled. */
const WIPE_MIN_SNAPSHOT_GENES = 200;

export interface RestoreCounts {
  repos: number;
  genes: number;
  geneIdCollisionsRehomed: number;
  chimeras: number;
  missions: number;
  hunts: number;
  sweeps: number;
  history: number;
  learning: number;
}

export interface RestoreOutcome {
  ok: boolean;
  reason: string;
  counts?: RestoreCounts;
}

/** One restore at a time per process — a promise slot, not a boolean:
 *  overlapping callers await the SAME in-flight restore instead of 409ing. */
let inFlight: Promise<RestoreOutcome> | null = null;

/** Read the gene count from the snapshot head without parsing ~20MB — a 4KB
 *  handle read + regex, the same trick dna-snapshot.ts uses; a miss returns
 *  null = "no opinion". Never loads the full file just to count. */
async function readSnapshotGeneCount(): Promise<number | null> {
  const { open } = await import("node:fs/promises");
  try {
    const fh = await open(SNAPSHOT_FILE, "r");
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
    return null; // no snapshot file (or unreadable) — nothing to heal FROM
  }
}

/** Read the whole snapshot, guarded — a corrupt/partial file reports a clean
 *  failure instead of throwing a raw SyntaxError through the caller. */
async function readSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Does the live DB look wiped compared to the snapshot on disk? */
export async function libraryLooksWiped(): Promise<boolean> {
  try {
    const [dbCount, snapCount] = await Promise.all([
      db.dnaArtifact.count(),
      readSnapshotGeneCount(),
    ]);
    return snapCount !== null && snapCount >= WIPE_MIN_SNAPSHOT_GENES && dbCount < Math.floor(snapCount / 2);
  } catch {
    // a failed check is NOT a wipe signal — never auto-restore on a DB error
    return false;
  }
}

/**
 * The full restore. Reads reports/state/dna-snapshot.json and reseeds every
 * public table (never the GitHub PAT — it is not in the snapshot by design).
 */
export async function restoreLibraryFromSnapshot(): Promise<RestoreOutcome> {
  const snap = await readSnapshot();
  if (!snap) return { ok: false, reason: "snapshot unreadable or missing" };

  const counts: RestoreCounts = {
    repos: 0,
    genes: 0,
    geneIdCollisionsRehomed: 0,
    chimeras: 0,
    missions: 0,
    hunts: 0,
    sweeps: 0,
    history: 0,
    learning: 0,
  };

  // 1) SavedRepo — natural key fullName; the update branch restores fields the
  //    historical restore forgot (license/models/evidence/description).
  for (const r of (snap.savedRepos ?? []) as Record<string, unknown>[]) {
    const fullName = String(r.fullName ?? "");
    if (!fullName.includes("/")) continue;
    try {
      await db.savedRepo.upsert({
        where: { fullName },
        create: {
          fullName,
          owner: String(r.owner ?? fullName.split("/")[0] ?? ""),
          name: String(r.name ?? fullName.split("/").slice(1).join("/")),
          url: String(r.url ?? `https://github.com/${fullName}`),
          description: (r.description as string | null) ?? null,
          stars: Number(r.stars ?? 0),
          score: Number(r.score ?? 0),
          models: (r.models as string | null) ?? null,
          evidence: (r.evidence as string | null) ?? null,
          license: (r.license as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          createdAt: dt(r.createdAt as string | null),
        },
        update: {
          score: Number(r.score ?? 0),
          stars: Number(r.stars ?? 0),
          notes: (r.notes as string | null) ?? null,
          license: (r.license as string | null) ?? null,
          models: (r.models as string | null) ?? null,
          evidence: (r.evidence as string | null) ?? null,
          description: (r.description as string | null) ?? null,
        },
      });
      counts.repos++;
    } catch {
      // one bad row must never abort the library heal
    }
  }

  // 2) DnaArtifact — id-first heal, natural-key second, and (the improvement)
  //    re-home a colliding gene under a fresh id when its natural key is free.
  for (const a of (snap.dnaArtifacts ?? []) as Record<string, unknown>[]) {
    const id = Number(a.id);
    const sourceRepo = String(a.sourceRepo ?? "");
    const genePath = String(a.path ?? "");
    if (!Number.isInteger(id) || !sourceRepo || !genePath) continue;
    const gene = {
      sourceRepo,
      path: genePath,
      kind: String(a.kind ?? "skill"),
      name: String(a.name ?? genePath),
      description: (a.description as string | null) ?? null,
      content: (a.content as string | null) ?? null,
      rawUrl: (a.rawUrl as string | null) ?? null,
      size: Number(a.size ?? 0),
      license: (a.license as string | null) ?? null,
      createdAt: dt(a.createdAt as string | null),
    };
    try {
      const byId = Number.isInteger(id) ? await db.dnaArtifact.findUnique({ where: { id } }) : null;
      if (byId) {
        if (byId.sourceRepo === sourceRepo && byId.path === genePath) {
          // same gene, possibly stale/partial — heal every restore-owned field
          await db.dnaArtifact.update({ where: { id }, data: gene });
          counts.genes++;
        } else {
          // id occupied by a DIFFERENT re-grown gene. Old script: skip forever.
          // Now: if the natural key is free, RE-HOME the gene under a fresh id —
          // its content returns to the library (search, compilation, export)
          // instead of rotting in the snapshot file. mission.dnaRefs pointing
          // at the old id dangle either way (the gene was absent under it).
          const byKey = await db.dnaArtifact.findUnique({
            where: { sourceRepo_path: { sourceRepo, path: genePath } },
          });
          if (!byKey) {
            // create WITHOUT an explicit id — the autoincrement assigns a fresh home;
            // the gene object carries exactly the create-input shape (no id field)
            await db.dnaArtifact.create({ data: gene });
            counts.geneIdCollisionsRehomed++;
            counts.genes++;
          }
        }
        continue;
      }
      await db.dnaArtifact.upsert({
        where: { sourceRepo_path: { sourceRepo, path: genePath } },
        create: { id, ...gene },
        update: gene,
      });
      counts.genes++;
    } catch {
      // a single colliding row (P2002 under extreme interleaving) is skipped,
      // loudly counted in the DB round but never aborts the heal
    }
  }

  // 3) Chimera — id-first, name+sources natural-key fallback
  for (const c of (snap.chimeras ?? []) as Record<string, unknown>[]) {
    const id = Number(c.id);
    if (!Number.isInteger(id)) continue;
    try {
      const byId = await db.chimera.findUnique({ where: { id } });
      if (byId) continue;
      const byKey = await db.chimera.findFirst({
        where: { name: String(c.name ?? ""), sources: String(c.sources ?? "") },
      });
      if (byKey) continue; // same creature re-created under a new id — keep the live row
      await db.chimera.create({
        data: {
          id,
          name: String(c.name ?? `chimera-${id}`),
          oneLiner: (c.oneLiner as string | null) ?? null,
          sources: String(c.sources ?? ""),
          skillMd: String(c.skillMd ?? ""),
          principles: (c.principles as string | null) ?? null,
          workOrders: (c.workOrders as string | null) ?? null,
          breakthrough: (c.breakthrough as string | null) ?? null,
          createdAt: dt(c.createdAt as string | null),
        },
      });
      counts.chimeras++;
    } catch {
      // never abort the heal on one bad creature
    }
  }

  // 4) Mission — id-first (hunt.missionId and mission.dnaRefs reference these ids)
  for (const m of (snap.missions ?? []) as Record<string, unknown>[]) {
    const id = Number(m.id);
    if (!Number.isInteger(id)) continue;
    try {
      const byId = await db.mission.findUnique({ where: { id } });
      if (byId) continue;
      await db.mission.create({
        data: {
          id,
          goal: String(m.goal ?? ""),
          context: (m.context as string | null) ?? null,
          status: String(m.status ?? "compiled"),
          missionName: String(m.missionName ?? `mission-${id}`),
          plan: String(m.plan ?? "{}"),
          dnaRefs: (m.dnaRefs as string | null) ?? null,
          promptSequence: (m.promptSequence as string | null) ?? null,
          skillMd: (m.skillMd as string | null) ?? null,
          risks: (m.risks as string | null) ?? null,
          successCriteria: (m.successCriteria as string | null) ?? null,
          report: (m.report as string | null) ?? null,
          autopilot: (m.autopilot as string | null) ?? null,
          autopilotAt: m.autopilotAt ? dt(m.autopilotAt as string) : null,
          createdAt: dt(m.createdAt as string | null),
        },
      });
      counts.missions++;
    } catch {
      // never abort the heal on one bad mission
    }
  }

  // 5) LiveHunt — id-preserving recreate (history integrity)
  for (const h of (snap.liveHunts ?? []) as Record<string, unknown>[]) {
    const id = Number(h.id);
    if (!Number.isInteger(id)) continue;
    try {
      const existing = await db.liveHunt.findUnique({ where: { id } });
      if (existing) continue;
      await db.liveHunt.create({
        data: {
          id,
          status: String(h.status ?? "done"),
          stageKey: String(h.stageKey ?? ""),
          stages: String(h.stages ?? "[]"),
          goal: String(h.goal ?? ""),
          missionId: h.missionId === null || h.missionId === undefined ? null : Number(h.missionId),
          generation: Number(h.generation ?? 1),
          seededFrom: (h.seededFrom as number | null) ?? null,
          dnaBefore: Number(h.dnaBefore ?? 0),
          dnaAfter: Number(h.dnaAfter ?? 0),
          llmCalls: Number(h.llmCalls ?? 0),
          elapsedMs: Number(h.elapsedMs ?? 0),
          error: (h.error as string | null) ?? null,
          createdAt: dt(h.createdAt as string | null),
        },
      });
      counts.hunts++;
    } catch {
      // never abort the heal on one bad hunt row
    }
  }

  // 6) SweepRun — id-preserving recreate, with one honesty fix: a snapshot row
  //    captured MID-RUN (status "running") describes a process that died with
  //    the server — no executeSweep loop survives a recycle. Restoring it as
  //    "running" is a GHOST: Prisma stamps a fresh updatedAt on create, so the
  //    15-minute reaper clock restarts and the ghost blocks every new sweep
  //    (409 "already running") for up to 15 minutes after every restore.
  //    Field fact (2026-11-14): restored #39 sat "running, swarm, 71%" for an
  //    hour while nothing drove it. It is restored as failed — same law the
  //    crash-recovery reaper already applies, same message.
  for (const s of (snap.sweepRuns ?? []) as Record<string, unknown>[]) {
    const id = Number(s.id);
    if (!Number.isInteger(id)) continue;
    try {
      const existing = await db.sweepRun.findUnique({ where: { id } });
      if (existing) continue;
      const wasRunning = String(s.status ?? "done") === "running";
      await db.sweepRun.create({
        data: {
          id,
          status: wasRunning ? "failed" : String(s.status ?? "done"),
          phase: String(s.phase ?? "done"),
          progress: Number(s.progress ?? 100),
          queries: (s.queries as string | null) ?? null,
          stats: (s.stats as string | null) ?? null,
          findings: (s.findings as string | null) ?? null,
          briefing: (s.briefing as string | null) ?? null,
          audit: (s.audit as string | null) ?? null,
          error: wasRunning
            ? "The run was interrupted (the server was recycled mid-run) — restored as failed by the library self-heal"
            : (s.error as string | null) ?? null,
          createdAt: dt(s.createdAt as string | null),
        },
      });
      counts.sweeps++;
    } catch {
      // never abort the heal on one bad sweep row
    }
  }

  // 7) SearchHistory — only when the table is empty (count-guard, same as the script)
  if ((await db.searchHistory.count()) === 0) {
    for (const h of (snap.searchHistory ?? []) as Record<string, unknown>[]) {
      try {
        await db.searchHistory.create({
          data: {
            mode: String(h.mode ?? "repos"),
            query: String(h.query ?? ""),
            filters: (h.filters as string | null) ?? null,
            resultCount: Number(h.resultCount ?? 0),
            createdAt: dt(h.createdAt as string | null),
          },
        });
        counts.history++;
      } catch {
        // never abort the heal on one bad history row
      }
    }
  }

  // 8) Learning state — fill MISSING rows only (a live DB's newer state wins)
  const learningState = (snap.learningState ?? {}) as Record<string, unknown>;
  for (const key of ["mineAttempts", "queryYieldStats", "frontierLedger"]) {
    const val = learningState[key];
    if (val === undefined || val === null) continue;
    try {
      const existing = await db.setting.findUnique({ where: { key } });
      if (existing) continue;
      await db.setting.create({ data: { key, value: JSON.stringify(val) } });
      counts.learning++;
    } catch {
      // never abort the heal on one bad learning row
    }
  }

  return { ok: true, reason: "restored", counts };
}

/**
 * Auto-heal entry point: restores ONLY when the DB looks wiped vs the
 * snapshot. Deduplicated via a promise slot — boot, the regression ratchet
 * and any future caller share one in-flight restore. Never throws.
 */
export function autoRestoreIfWiped(): Promise<RestoreOutcome> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<RestoreOutcome> => {
    try {
      if (!(await libraryLooksWiped())) {
        return { ok: false, reason: "not wiped — no restore needed" };
      }
      const snapCount = await readSnapshotGeneCount();
      const before = await db.dnaArtifact.count();
      console.log(
        `[dna-restore] wipe detected (DB holds ${before} genes, snapshot holds ${snapCount}) — self-healing the library`,
      );
      const out = await restoreLibraryFromSnapshot();
      if (out.ok) {
        const after = await db.dnaArtifact.count();
        const note = `library self-healed — ${before} → ${after} genes (${out.counts?.genes ?? 0} restored, ${out.counts?.geneIdCollisionsRehomed ?? 0} re-homed)`;
        console.log(`[dna-restore] ${note}`);
        emitDnaBorn({ name: "library self-heal", source: "dna-snapshot", origin: "restore", note });
        emitAutonomy({ note, mode: "watchdog" });
        return { ...out, reason: note };
      }
      console.error(`[dna-restore] self-heal failed: ${out.reason}`);
      emitAutonomy({ note: `library self-heal FAILED — ${out.reason} (manual: node scripts/dna-restore.mjs)`, mode: "watchdog" });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("[dna-restore] self-heal crashed:", msg);
      return { ok: false, reason: msg };
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
