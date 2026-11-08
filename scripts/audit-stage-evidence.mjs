import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

for (const hid of [5, 6]) {
  const h = await db.liveHunt.findUnique({ where: { id: hid } });
  const stages = JSON.parse(h.stages || "[]");
  console.log(`\n########## HUNT ${hid} (gen ${h.generation}, mission ${h.missionId}) ##########`);
  for (const s of stages) {
    const ev = s.evidence ?? {};
    const evKeys = Object.keys(ev);
    console.log(`\n--- stage [${s.key}] evidence keys: ${JSON.stringify(evKeys)}`);
    // print each evidence value, truncated smartly
    for (const k of evKeys) {
      let v = ev[k];
      let str;
      if (v === null) str = "null";
      else if (Array.isArray(v)) str = `ARRAY(${v.length}): ` + JSON.stringify(v.slice(0, 3)).slice(0, 400);
      else if (typeof v === "object") str = JSON.stringify(v).slice(0, 500);
      else str = String(v).slice(0, 300);
      console.log(`   ${k} => ${str}`);
    }
    // stage narrative if exists
    for (const nk of ["summary", "note", "notes", "narrative"]) {
      if (s[nk]) console.log(`   NARRATIVE[${nk}] => ${String(s[nk]).slice(0, 600)}`);
    }
  }
}
await db.$disconnect();
