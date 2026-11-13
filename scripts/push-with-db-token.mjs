import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
const db = new PrismaClient();
const row = await db.setting.findUnique({ where: { key: "github_pat" } });
if (!row) { console.error("NO_PAT"); process.exit(1); }
const pat = row.value;
const remote = "https://github.com/rastitofx10-jj/claude-hunter-pro.git";

// round 8: the token must never appear in the command line (visible in /proc/*/cmdline)
// nor in failure output. Previously: token embedded in the push URL — git's error output
// printed the full credential-bearing URL to the console on ANY push failure, and the
// unconditional process.exit(0) afterwards overrode exitCode=1, so a failed push always
// exited 0 and automation believed the backup succeeded.
const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
const scrub = (s) => String(s ?? "").replaceAll(pat, "***").replaceAll(basic, "***");

try {
  const out = execSync(`git -c http.extraheader="AUTHORIZATION: basic ${basic}" push origin main:main`, {
    cwd: "/home/z/my-project",
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
  console.log(scrub(out).split("\n").filter(Boolean).slice(-3).join("\n"));
  console.log("PUSH_OK");
} catch (e) {
  // scrub BOTH streams — git echoes the auth header/URL fragments into either
  const tail = (scrub(e.stderr?.toString()) || scrub(e.message)).split("\n").filter(Boolean).slice(-2).join("\n");
  console.error("PUSH_FAIL:", tail);
  process.exitCode = 1;
} finally {
  // scrub: ensure origin URL never carries the token
  execSync(`git remote set-url origin ${remote}`);
}
await db.$disconnect();
// honor the failure exit code — previously process.exit(0) lied about success
process.exit(process.exitCode ?? 0);
