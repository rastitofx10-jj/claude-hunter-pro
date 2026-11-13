import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const [genes, hunts, sweeps, chimeras, missions, saved] = await Promise.all([
  db.dnaArtifact.count(), db.liveHunt.count(), db.sweepRun.count(),
  db.chimera.count(), db.mission.count(), db.savedRepo.count()
]);
const lastHunt = await db.liveHunt.findFirst({ orderBy: { createdAt: 'desc' } });
const lastSweep = await db.sweepRun.findFirst({ orderBy: { createdAt: 'desc' } });
const token = await db.setting.findUnique({ where: { key: 'github_pat' } });
// round 8: `findingsCount` is not a column on SweepRun (findings is a JSON string) —
// JSON.stringify silently dropped the undefined key and the diagnostic reported sweeps
// with NO findings count at all. Parse the real array length now.
let lastSweepFindings = null;
try { lastSweepFindings = Array.isArray(JSON.parse(lastSweep?.findings ?? '[]')) ? JSON.parse(lastSweep?.findings ?? '[]').length : null; } catch { lastSweepFindings = null; }
console.log(JSON.stringify({
  genes, hunts, sweeps, chimeras, missions, saved,
  lastHunt: lastHunt ? { gen: lastHunt.generation, status: lastHunt.status, at: lastHunt.createdAt } : null,
  lastSweep: lastSweep ? { id: lastSweep.id, findings: lastSweepFindings, at: lastSweep.createdAt } : null,
  tokenSet: !!token
}, null, 2));
await db.$disconnect();
