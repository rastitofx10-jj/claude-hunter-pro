import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const repos = await db.savedRepo.findMany({ select: { fullName: true, models: true, score: true, description: true } });
for (const r of repos) {
  console.log(`${r.score}\t${r.fullName}\tmodels=${(r.models ?? '-').slice(0, 80)}`);
}
console.log('total:', repos.length);
await db.$disconnect();
