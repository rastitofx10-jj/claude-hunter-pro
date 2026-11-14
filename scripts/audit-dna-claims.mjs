// audit-dna-claims.mjs — round 12 skeptic tool: verify DNA-library claims
// directly against the DB (never against reports). Usage: bun run scripts/audit-dna-claims.mjs
import { db } from '../src/lib/db';
async function main() {
  const total = await db.dnaArtifact.count();
  const self = await db.dnaArtifact.count({ where: { license: 'self' } });
  const field = await db.dnaArtifact.count({ where: { sourceRepo: { startsWith: 'field:' } } });
  const latest = await db.dnaArtifact.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, name: true, createdAt: true, kind: true, license: true } });
  console.log(JSON.stringify({ total, selfBorn: self, fieldDna: field, latest }, null, 1));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
