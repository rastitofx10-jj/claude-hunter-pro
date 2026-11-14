import { readFileSync } from "fs";
import { readdirSync } from "fs";
const dir = "./.data/chimera-drafts";
try {
  const files = readdirSync(dir);
  console.log("FILES:", files);
  for (const f of files) {
    const raw = readFileSync(`${dir}/${f}`, "utf8");
    const d = JSON.parse(raw);
    const md = d.chimera?.skillMd ?? d.skillMd ?? "";
    console.log("=== draft", f, "name:", d.chimera?.chimeraName ?? d.chimeraName);
    console.log("SKILL HEAD (first 400 chars):");
    console.log(md.slice(0, 400));
    console.log("... hasFront:", /^---\r?\n[\s\S]*?\r?\n---/.test(md));
  }
} catch (e) {
  console.log("ERR:", e instanceof Error ? e.message : e);
}
