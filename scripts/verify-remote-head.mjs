#!/usr/bin/env node
/**
 * verify-remote-head.mjs — does what its name says: fetches the ACTUAL branch
 * head of main from GitHub and compares it to the local HEAD.
 *
 * FIELD FACT (2026-11-13): the old version queried
 * `commits?path=reports/evolution/hunt-gen4.md` — a PATH-SCOPED history — and
 * printed its newest result as if it were the branch head. While the real
 * remote head was 9b909b5, the tool reported c631cf4 (the last commit that
 * touched that one file). A verification tool that verifies the wrong thing is
 * worse than no tool: its output looks authoritative. Fixed to query
 * /branches/main and diff against local HEAD — exit code 1 on divergence.
 */
import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";

const db = new PrismaClient();
try {
  const row = await db.setting.findUnique({ where: { key: "github_pat" } });
  if (!row?.value) { console.error("NO_PAT"); process.exit(1); }

  const res = await fetch(
    "https://api.github.com/repos/rastitofx10-jj/claude-hunter-pro/branches/main",
    { headers: { Authorization: `Bearer ${row.value}`, Accept: "application/vnd.github+json" } }
  );
  if (res.status !== 200) { console.error("API_ERR", res.status); process.exit(1); }
  const j = await res.json();
  const remoteSha = j.commit?.sha;
  const remoteMsg = (j.commit?.commit?.message ?? "").split("\n")[0];

  const localSha = execSync("git rev-parse HEAD", { cwd: "/home/z/my-project" }).toString().trim();

  const match = remoteSha === localSha;
  console.log(JSON.stringify({
    remoteHead: remoteSha?.slice(0, 7),
    localHead: localSha.slice(0, 7),
    inSync: match,
    remoteMsg: remoteMsg.slice(0, 80),
  }, null, 1));
  process.exit(match ? 0 : 1);
} finally {
  await db.$disconnect();
}
