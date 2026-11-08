// Round-6 helper: quick DB table census (dev diagnostics)
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type='table'",
  )
  for (const t of tables.map((x) => x.name).filter((n) => !n.startsWith('_prisma'))) {
    const c = await db.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(*) as c FROM "${t}"`)
    console.log(`${t}: ${c[0]?.c ?? 0}`)
  }
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
