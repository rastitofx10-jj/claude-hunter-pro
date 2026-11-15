// ============================================================
// Round 14 test — the durable token mirror (survives db/ recycles).
//
// WHY: the sandbox recycles and wipes db/custom.db (field fact ×3). The
// library self-heal restores genes/hunts/sweeps/learning but NEVER the
// GitHub PAT — so every recycle reverted the app to token-less and
// "Start an autonomous live hunt" failed with 400 "No GitHub token"
// (the user's recurring "failed to launch" report). The fix mirrors the
// verified token to reports/state/gh-token.txt and re-seeds the DB at
// boot / at hunt start.
//
// ISOLATION: runs against a throwaway SQLite file + a throwaway mirror
// file (env overrides read at import time — set BEFORE the dynamic
// imports). The real db/custom.db and the real mirror are never touched.
// ============================================================
let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
};

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const sandbox = mkdtempSync(path.join(tmpdir(), "hunter-token-test-"));
const testDb = `file:${path.join(sandbox, "test.db")}`;
const testMirror = path.join(sandbox, "gh-token.txt");

// Env BEFORE import — db.ts and server-token.ts read these at module load.
process.env.DATABASE_URL = testDb;
process.env.HUNTER_TOKEN_FILE = testMirror;

// Create the isolated schema (no client regeneration — the project's
// generated client is reused; only the DATABASE_URL differs).
execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  cwd: process.cwd(),
  stdio: "pipe",
  env: { ...process.env, DATABASE_URL: testDb },
});

const { db } = await import("../src/lib/db");
const { persistToken, clearStoredToken, restoreTokenFromFile, TOKEN_KEY, TOKEN_FILE } =
  await import("../src/lib/server-token");

const FAKE = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // structurally valid, never a real PAT
const readRow = async () => (await db.setting.findUnique({ where: { key: TOKEN_KEY } }))?.value ?? null;

try {
  // 1. persistToken writes BOTH the DB row and the durable mirror file
  check("persistToken returns true", (await persistToken(FAKE)) === true);
  check("persistToken → DB row holds the token", (await readRow()) === FAKE);
  check("persistToken → mirror file holds the token", existsSync(TOKEN_FILE) && readFileSync(TOKEN_FILE, "utf8").trim() === FAKE);

  // 2. restoreTokenFromFile is a no-op when the DB already holds a token
  //    (the mirror is a backup, NEVER an authority that overwrites)
  check("restore is a no-op when the DB has a token", (await restoreTokenFromFile()) === false);
  check("no-op restore did not overwrite the DB", (await readRow()) === FAKE);

  // 3. THE FIELD FACT: a sandbox recycle wipes the DB row — restore heals it
  await db.setting.deleteMany({ where: { key: TOKEN_KEY } });
  check("wipe simulation: DB row gone", (await readRow()) === null);
  check("restore after wipe returns true", (await restoreTokenFromFile()) === true);
  check("restore after wipe re-seeded the DB", (await readRow()) === FAKE);

  // 4. Nothing to heal from (mirror missing too) → false, no crash, no row
  await db.setting.deleteMany({ where: { key: TOKEN_KEY } });
  rmSync(testMirror);
  check("restore with no mirror + no row → false", (await restoreTokenFromFile()) === false);
  check("restore with no sources left no row", (await readRow()) === null);

  // 5. A structurally invalid mirror (garbage file) is refused — never healed into the DB
  writeFileSync(testMirror, "not a token just garbage bytes", "utf8");
  check("invalid mirror content → refused", (await restoreTokenFromFile()) === false);
  check("invalid mirror never entered the DB", (await readRow()) === null);

  // 6. persistToken refuses garbage in the first place (no DB row, no file)
  rmSync(testMirror);
  check("persistToken(garbage) refused", (await persistToken("short")) === false);
  check("persistToken(garbage) wrote nothing", !existsSync(TOKEN_FILE) && (await readRow()) === null);

  // 7. clearStoredToken removes BOTH sides
  await persistToken(FAKE);
  await clearStoredToken();
  check("clearStoredToken removed the DB row", (await readRow()) === null);
  check("clearStoredToken removed the mirror file", !existsSync(TOKEN_FILE));
} finally {
  await db.$disconnect();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
