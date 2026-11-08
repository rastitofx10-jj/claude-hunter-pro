import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

const db = new PrismaClient();
const row = await db.setting.findUnique({ where: { key: "github_pat" } });
if (!row) { console.error("NO_PAT"); process.exit(1); }
const pat = row.value;
const REPO = "rastitofx10-jj/claude-hunter-pro";
const H = { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "audit-round3" };

const gh = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  if (!r.ok) throw new Error(`GH ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// --- 1. repo meta (no secret values printed) ---
const repo = await gh(`/repos/${REPO}`);
console.log("REPO:", JSON.stringify({ private: repo.private, visibility: repo.visibility, default_branch: repo.default_branch, pushed_at: repo.pushed_at, size_kb: repo.size }));

// --- 2. local HEAD vs remote HEAD ---
const localHead = execSync("git rev-parse HEAD", { cwd: "/home/z/my-project" }).toString().trim();
console.log("LOCAL_HEAD:", localHead);
const commits = await gh(`/repos/${REPO}/commits?per_page=5`);
console.log("REMOTE_COMMITS:", commits.map(c => `${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0].slice(0,80)}`).join(" | "));

// --- 3. full remote tree ---
const tree = await gh(`/repos/${REPO}/git/trees/${repo.default_branch}?recursive=1`);
const remoteFiles = new Map(tree.tree.filter(t => t.type === "blob").map(t => [t.path, t.sha]));
console.log("REMOTE_BLOB_COUNT:", remoteFiles.size, "TRUNCATED:", tree.truncated);

// --- 4. local tracked files + blob shas ---
const lsOut = execSync("git ls-files -s", { cwd: "/home/z/my-project" }).toString().trim().split("\n");
const localFiles = new Map();
for (const line of lsOut) {
  const [, sha, , path] = line.trim().split(/\s+/);
  localFiles.set(path, sha);
}
console.log("LOCAL_BLOB_COUNT:", localFiles.size);

// --- 5. sensitive paths on remote tree ---
const sensitive = [...remoteFiles.keys()].filter(p =>
  /\.(db|sqlite|sqlite3|log|pem|key)$/i.test(p) || /(^|\/)\.env($|\.)/i.test(p) || /dev\.log/i.test(p)
);
console.log("SENSITIVE_REMOTE_FILES:", sensitive.length ? sensitive.join(", ") : "NONE");

// --- 6. drift: local vs remote ---
const onlyLocal = [], onlyRemote = [], diff = [];
for (const [p, sha] of localFiles) {
  if (!remoteFiles.has(p)) onlyLocal.push(p);
  else if (remoteFiles.get(p) !== sha) diff.push(p);
}
for (const p of remoteFiles.keys()) if (!localFiles.has(p)) onlyRemote.push(p);
console.log("ONLY_LOCAL(", onlyLocal.length, "):", onlyLocal.slice(0, 30).join(", "));
console.log("ONLY_REMOTE(", onlyRemote.length, "):", onlyRemote.slice(0, 30).join(", "));
console.log("CONTENT_DIFF(", diff.length, "):", diff.slice(0, 50).join(", "));

// --- 7. remote origin URL hygiene ---
const remoteUrl = execSync("git remote get-url origin", { cwd: "/home/z/my-project" }).toString().trim();
console.log("ORIGIN_URL_HAS_TOKEN:", remoteUrl.includes("x-access-token") || /https:\/\/[^@/]*@/.test(remoteUrl));

await db.$disconnect();
