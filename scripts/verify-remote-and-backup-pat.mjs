import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const pat = await db.setting.findUnique({ where: { key: "github_pat" } });
if (!pat) { console.error("NO_PAT"); process.exit(1); }

// round 8: this used to dump the PAT plaintext into /tmp/pat.bak — a one-way
// persistent secret leak OUTSIDE the repo that nothing ever read and nothing
// cleaned (same-user processes could read it indefinitely). The DB and
// upload/token.secret are already the recovery paths; the /tmp dump is removed.

// 2. verify remote file content via GitHub API
// round 8: no timeout (a stalled connection hung the script forever) and no status
// check (a 401/404/500 still printed "status" and exited 0 — the exit code lied
// about success, the one thing this family of tools exists for).
try {
  const res = await fetch(
    "https://api.github.com/repos/rastitofx10-jj/claude-hunter-pro/contents/src/lib/api-client.ts?ref=main",
    { headers: { Authorization: `Bearer ${pat.value}`, Accept: "application/vnd.github.raw+json" }, signal: AbortSignal.timeout(15_000) }
  );
  const body = await res.text();
  console.log(JSON.stringify({
    status: res.status,
    hasServerToken: body.includes("SERVER_TOKEN"),
    hasIsServerToken: body.includes("isServerToken"),
    bytes: body.length,
  }));
  await db.$disconnect();
  process.exit(res.status === 200 ? 0 : 1);
} catch (e) {
  console.error("VERIFY_FAIL:", String(e?.message ?? e).slice(0, 200));
  await db.$disconnect();
  process.exit(1);
}
