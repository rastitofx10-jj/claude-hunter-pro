#!/usr/bin/env node
/**
 * run-sweep-only.mjs — dedicated sweep window: cold-start server → zombie-guard →
 * start/resume a sweep → poll to completion. No new hunt (the pump already did it).
 * Exists because the 10-min bash window kills the pump mid-sweep, and every pump
 * resume would burn a fresh hunt before reaching the sweep.
 * Usage: node scripts/run-sweep-only.mjs
 */
const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (path, init = {}, timeoutMs = 320_000) => {
  const once = async () => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  try { return await once(); } catch { await sleep(2000); try { return await once(); } catch { return { status: 0, body: null }; } }
};

const note = (ok, label, extra = "") =>
  console.log(`${ok ? "PASS" : "WARN"} | ${label}${extra ? " | " + extra : ""}`);

// ---- cold-start (same ownership model as the pump) ----
const { spawn } = await import("node:child_process");
let alive = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.log("server down — cold-starting dev server…");
  spawn("bun", ["run", "dev"], { cwd: "/home/z/my-project", stdio: "ignore", detached: false });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    alive = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
    if (alive) break;
  }
}
if (!alive) { console.error("FATAL | dev server would not start"); process.exit(1); }
note(true, "server up");

// ---- zombie guard: any sweep claiming to run with a stale heartbeat is dead ----
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const staleCut = Date.now() - 3 * 60_000; // this runner just cold-started: anything not updated in 3 min is frozen
const zombies = await db.sweepRun.findMany({ where: { status: "running" }, select: { id: true, updatedAt: true } });
const dead = zombies.filter((z) => new Date(z.updatedAt).getTime() < staleCut);
if (dead.length > 0) {
  await db.sweepRun.updateMany({
    where: { id: { in: dead.map((z) => z.id) } },
    data: { status: "failed", error: "run interrupted (server recycled mid-sweep) — auto-marked by sweep runner" },
  });
  note(false, `zombie sweeps`, `${dead.map((z) => "#" + z.id).join(", ")} marked failed`);
}
await db.$disconnect();

// ---- start or resume a sweep ----
const list = await j("/api/sweep", {}, 20_000);
let sweepId = list.body?.active?.id ?? null;
if (!sweepId) {
  const start = await j("/api/sweep", { method: "POST" }, 30_000);
  if (start.status !== 200) { console.error("FATAL | sweep start:", JSON.stringify(start.body).slice(0, 150)); process.exit(1); }
  sweepId = start.body.id;
  note(true, `sweep #${sweepId} started`);
}

// ---- poll to completion (window budget ~8 min) ----
const deadline = Date.now() + 480_000;
let lastPhase = "";
while (Date.now() < deadline) {
  const r = await j(`/api/sweep/${sweepId}`, {}, 30_000);
  const row = r.body;
  if (row?.phase !== lastPhase) { lastPhase = row?.phase ?? "?"; note(true, `sweep #${sweepId}`, `phase=${lastPhase} progress=${row?.progress ?? 0}%`); }
  if (row?.status === "done") {
    const st = row.stats ?? {};
    note(true, `sweep #${row.id} done`, `${(row.findings ?? []).length} findings · llm=${st.llmCalls ?? 0} · qualityRejected=${st.qualityRejectedTotal ?? "?"} · attribution=${Object.keys(st.queryAttribution ?? {}).length} queries`);
    console.log("SWEEP_COMPLETE");
    process.exit(0);
  }
  if (row?.status === "failed") { console.error("FATAL | sweep failed:", String(row.error ?? "").slice(0, 150)); process.exit(1); }
  await sleep(4000);
}
note(false, `sweep #${sweepId}`, "window timeout — resumable (rerun this script)");
console.log("SWEEP_WINDOW_TIMEOUT");
process.exit(0);
