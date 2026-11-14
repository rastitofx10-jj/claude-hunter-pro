import { db } from "../src/lib/db";
async function main() {
  try {
    const row = await db.setting.findUnique({ where: { key: "github_pat" } });
    console.log("TOKEN_ROW:", row ? `${row.value.slice(0, 12)}... len=${row.value.length} updated=${row.updatedAt}` : "NULL");
    const models = await db.$runCommandRaw ? null : null;
    const counts: Record<string, number> = {};
    for (const m of ["savedRepo", "searchHistory", "analysis", "mission", "huntSession", "sweep"]) {
      try { counts[m] = await (db as any)[m].count(); } catch { counts[m] = -1; }
    }
    console.log("COUNTS:", JSON.stringify(counts));
  } catch (e) {
    console.error("ERR:", e instanceof Error ? e.message : e);
  }
}
main();
