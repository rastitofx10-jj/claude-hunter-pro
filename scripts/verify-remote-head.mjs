import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const row = await db.setting.findUnique({ where: { key: "github_pat" } });
const res = await fetch(
  "https://api.github.com/repos/rastitofx10-jj/claude-hunter-pro/commits?per_page=2&path=reports/evolution/hunt-gen4.md",
  { headers: { Authorization: `Bearer ${row.value}`, Accept: "application/vnd.github+json" } }
);
const js = await res.json();
if (!Array.isArray(js)) { console.log("API_ERR", res.status, JSON.stringify(js).slice(0, 120)); process.exit(1); }
console.log(JSON.stringify(js.map(c => ({ sha: c.sha.slice(0, 7), msg: c.commit.message.split("\n")[0].slice(0, 70) })), null, 1));
await db.$disconnect();
process.exit(0);
