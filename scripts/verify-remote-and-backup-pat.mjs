import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const pat = await db.setting.findUnique({ where: { key: "github_pat" } });
if (!pat) { console.error("NO_PAT"); process.exit(1); }

// 1. backup PAT to /tmp (survives tool-call process kills)
const fs = await import("fs");
fs.writeFileSync("/tmp/pat.bak", pat.value, { mode: 0o600 });

// 2. verify remote file content via GitHub API
const res = await fetch(
  "https://api.github.com/repos/rastitofx10-jj/claude-hunter-pro/contents/src/lib/api-client.ts?ref=main",
  { headers: { Authorization: `Bearer ${pat.value}`, Accept: "application/vnd.github.raw+json" } }
);
const body = await res.text();
console.log(JSON.stringify({
  status: res.status,
  hasServerToken: body.includes("SERVER_TOKEN"),
  hasIsServerToken: body.includes("isServerToken"),
  bytes: body.length,
}));
await db.$disconnect();
process.exit(0);
