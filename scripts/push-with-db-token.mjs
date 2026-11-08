import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
const db = new PrismaClient();
const row = await db.setting.findUnique({ where: { key: "github_pat" } });
if (!row) { console.error("NO_PAT"); process.exit(1); }
const pat = row.value;
const remote = "https://github.com/rastitofx10-jj/claude-hunter-pro.git";
const tokenUrl = remote.replace("https://", `https://x-access-token:${pat}@`);
try {
  const out = execSync(`git push "${tokenUrl}" main:main`, {
    cwd: "/home/z/my-project",
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
  console.log(out.split("\n").filter(Boolean).slice(-3).join("\n"));
  console.log("PUSH_OK");
} catch (e) {
  console.error("PUSH_FAIL:", (e.stderr?.toString() || e.message).slice(-300));
  process.exitCode = 1;
} finally {
  // scrub: ensure origin URL never carries the token
  execSync(`git remote set-url origin ${remote}`);
}
await db.$disconnect();
process.exit(0);
