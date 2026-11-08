import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const genes = await db.dnaArtifact.findMany({
  orderBy: { id: "desc" },
  take: 5,
  select: { id: true, kind: true, sourceRepo: true, path: true },
});
console.log(JSON.stringify(genes, null, 1));
await db.$disconnect();
process.exit(0);
