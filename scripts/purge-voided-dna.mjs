// ============================================================
// Round 9 one-time purge — delete field: DNA born from VOIDED missions.
//
// The truth-migration voided 24 fiction-era missions, but the `field:livehunt-N`
// DNA rows those missions birthed stayed alive: mission-compiler's ranker gave
// them the +2 "field-proven" boost and dedup tie-break wins, so every new
// compilation preferred DNA whose provenance was fabricated intel the migration
// purged. Round 8 closed the FUTURE birth path (report/autopilot 409 on voided);
// this script removes the survivors outright, and selectDnaForGoal's
// quarantineVoidedFieldDna keeps the selection honest even before a purge runs.
//
// Also repairs the voided missions' scrambled report history: truth-migration
// spread an array into a numeric-key object ({"0":{...},"1":{...},voidedAt:...})
// — re-wrapped here into the array format the reader expects.
// Idempotent: re-running is a no-op. Reports what it did; exits non-zero only
// on a DB failure.
// ============================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: "file:/home/z/my-project/db/custom.db" } },
});

async function main() {
  // ---- 1. Voided mission ids ----
  const voidedMissions = await prisma.mission.findMany({
    where: { status: "voided" },
    select: { id: true, report: true },
  });
  const voidedIds = new Set(voidedMissions.map((m) => m.id));
  console.log(`[purge] voided missions: ${voidedIds.size}`);

  // ---- 2. Resolve field: DNA parents ----
  const fieldRows = await prisma.dnaArtifact.findMany({
    where: { sourceRepo: { startsWith: "field:" } },
    select: { id: true, sourceRepo: true, name: true },
  });
  console.log(`[purge] field: DNA rows: ${fieldRows.length}`);

  const livehuntIds = fieldRows
    .map((r) => r.sourceRepo.match(/^field:livehunt-?(\d+)$/i)?.[1])
    .filter(Boolean)
    .map(Number);
  const huntMission = new Map();
  if (livehuntIds.length > 0) {
    const hunts = await prisma.liveHunt.findMany({
      where: { id: { in: livehuntIds } },
      select: { id: true, missionId: true },
    });
    for (const h of hunts) huntMission.set(h.id, h.missionId);
  }

  const doomed = fieldRows.filter((r) => {
    const m = r.sourceRepo.match(/(?:^|[-_])mission-?(\d+)$/i);
    if (m && voidedIds.has(Number(m[1]))) return true;
    const h = r.sourceRepo.match(/^field:livehunt-?(\d+)$/i);
    if (h) {
      const mid = huntMission.get(Number(h[1]));
      if (mid != null && voidedIds.has(mid)) return true;
    }
    return false;
  });

  if (doomed.length === 0) {
    console.log("[purge] no voided-born field DNA found — already clean.");
  } else {
    console.log(`[purge] deleting ${doomed.length} voided-born field rows:`);
    for (const d of doomed) console.log(`        #${d.id} ${d.sourceRepo} — ${d.name}`);
    const res = await prisma.dnaArtifact.deleteMany({
      where: { id: { in: doomed.map((d) => d.id) } },
    });
    console.log(`[purge] deleted ${res.count} rows.`);
  }

  // ---- 3. Repair scrambled voided report history ----
  // truth-migration did `{...existingReport, ...reason}` where existingReport was
  // an ARRAY — spreading an array into an object literal produces numeric keys
  // ({"0":…,"1":…}), which the mission reader parses as one bogus legacy report.
  let repaired = 0;
  for (const m of voidedMissions) {
    if (!m.report) continue;
    let parsed;
    try {
      parsed = JSON.parse(m.report);
    } catch {
      continue;
    }
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") continue;
    const keys = Object.keys(parsed);
    const numeric = keys.filter((k) => /^\d+$/.test(k));
    if (numeric.length === 0) continue;
    // numeric keys back into an array; the rest (voidedAt, reason, …) stay on the object
    const arr = numeric.sort((a, b) => Number(a) - Number(b)).map((k) => parsed[k]);
    const meta = {};
    for (const k of keys) if (!/^\d+$/.test(k)) meta[k] = parsed[k];
    await prisma.mission.update({
      where: { id: m.id },
      data: { report: JSON.stringify({ history: arr, ...meta }) },
    });
    repaired++;
  }
  console.log(`[purge] repaired scrambled report histories: ${repaired}`);

  const total = await prisma.dnaArtifact.count();
  console.log(`[purge] library now: ${total} genes`);
}

main()
  .catch((e) => {
    console.error("[purge] FAILED:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
