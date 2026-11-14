// Purges SELF-GENERATED non-English rows (written by the old AI module in Hebrew) from the
// DNA snapshot. Third-party mined files (SKILL.md / AGENTS.md of other repos) are never touched.
//   node scripts/purge-non-english.mjs [path/to/dna-snapshot.json] [--dry]
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const file = process.argv.find((a) => a.endsWith(".json")) ?? "reports/state/dna-snapshot.json";
const dry = process.argv.includes("--dry");
const HEB = /[\u0590-\u05FF]/;
const hasHeb = (r) => HEB.test(JSON.stringify(r));
const snap = JSON.parse(readFileSync(file, "utf8"));
const out = {};

for (const t of ["missions", "chimeras", "liveHunts", "sweepRuns"]) {
  const before = snap[t].length;
  snap[t] = snap[t].filter((r) => !hasHeb(r));
  out[t] = before - snap[t].length;
}
{
  const before = snap.dnaArtifacts.length;
  snap.dnaArtifacts = snap.dnaArtifacts.filter((r) => !(String(r.sourceRepo).startsWith("field:") && hasHeb(r)));
  out.dnaArtifacts = before - snap.dnaArtifacts.length;
}
{
  let n = 0;
  for (const r of snap.savedRepos) {
    for (const f of ["notes", "evidence"]) {
      if (typeof r[f] === "string" && HEB.test(r[f])) {
        r[f] = f === "evidence" ? "[]" : null;
        n++;
      }
    }
  }
  out.savedRepoFieldsCleared = n;
}
for (const k of Object.keys(snap.counts)) if (Array.isArray(snap[k])) snap.counts[k] = snap[k].length;
console.log(`${dry ? "[dry] " : ""}${file}:`, out);
if (!dry) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  renameSync(tmp, file);
}
