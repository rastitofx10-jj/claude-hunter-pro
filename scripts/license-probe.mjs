// probe: what does GitHub actually return for the 27 stuck-license repos?
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const db = new PrismaClient();
const tokenRow = await db.setting.findUnique({ where: { key: "github_pat" } });
const token = tokenRow?.value ?? readFileSync("upload/טוקן טיטפקס10.secret", "utf8").trim();

const genes = await db.dnaArtifact.groupBy({
  by: ["sourceRepo"],
  where: { license: null, sourceRepo: { not: { startsWith: "field:" } } },
});
const watch = await db.savedRepo.findMany({ where: { license: null }, select: { fullName: true } });
const names = [...new Set([...genes.map((g) => g.sourceRepo), ...watch.map((w) => w.fullName)])];

// batch probe
let nulls = 0, noassert = 0, spdx = 0, errors = 0;
const details = [];
for (let i = 0; i < names.length; i += 40) {
  const chunk = names.slice(i, i + 40);
  const aliases = chunk
    .map((name, j) => {
      const [owner, repo] = name.split("/");
      if (!owner || !repo) return null;
      return `r${j}: repository(owner: "${owner}", name: "${repo}") { licenseInfo { spdxId } }`;
    })
    .filter(Boolean);
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "claude-hunter-pro" },
    body: JSON.stringify({ query: `query { ${aliases.join(" ")} }` }),
  });
  const data = await res.json();
  chunk.forEach((name, j) => {
    const node = data?.data?.[`r${j}`];
    if (node === null) { errors++; details.push(`${name} => REPO_GONE (null)`); }
    else if (node?.licenseInfo?.spdxId === "NOASSERTION") { noassert++; details.push(`${name} => NOASSERTION`); }
    else if (node?.licenseInfo?.spdxId) { spdx++; details.push(`${name} => ${node.licenseInfo.spdxId} (would fill!)`); }
    else if (node && !node.licenseInfo) { nulls++; if (details.length < 40) details.push(`${name} => NO_LICENSE_FILE`); }
    else { errors++; details.push(`${name} => WEIRD: ${JSON.stringify(node)}`); }
  });
}
console.log(`probed=${names.length} | no_license_file=${nulls} | fillable_spdx=${spdx} | noassertion=${noassert} | errors=${errors}`);
console.log(details.slice(0, 30).join("\n"));
await db.$disconnect();
