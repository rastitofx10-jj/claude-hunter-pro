import { PrismaClient } from '@prisma/client'

// The classic Next.js singleton pattern — globalThis cache in dev so hot
// reloads don't leak clients. The cast is REQUIRED: it puts PrismaClient in a
// TYPE position. (A previous rewrite accidentally used the union in a VALUE
// position — `PrismaClient | undefined` is a bitwise-OR number — and `db`
// silently became NaN. Typecheck caught it; that's why builds must stay honest.)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Startup transparency: WHICH SQLite file is this process actually using?
// Two facts users keep getting bitten by:
//  1. A relative `file:./db/x.db` is resolved by Prisma against the SCHEMA
//     directory (prisma/), not the project root.
//  2. An exported DATABASE_URL from the environment silently wins over .env.
// One log line at boot removes the mystery of a "disappearing" database.
const dbUrl = process.env.DATABASE_URL ?? "(unset)"
const relativeNote = /^file:\.{1,2}\//.test(dbUrl)
  ? " — relative file: URL; Prisma resolves it against the schema dir (prisma/)"
  : "";
console.log(`[db] DATABASE_URL=${dbUrl}${relativeNote}`)

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db as PrismaClient