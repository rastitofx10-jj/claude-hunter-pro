#!/usr/bin/env node
/**
 * pump-extra-gen.mjs — force one extra intelligence generation TODAY, bypassing
 * the 20h "once a day" gate in daily-cycle.mjs (that gate is cycle-script-only;
 * the APIs themselves are stateless about it). The user asked for maximum
 * potential → more generations per day, each with a new frontier rotation slice.
 *
 * Resumable: if a hunt/sweep is already running it picks it up instead of
 * starting a duplicate. Phases: hunt → harvest → sweep. Then run
 * scripts/chimera-live.mjs separately (needs the server up).
 *
 * Usage: node scripts/pump-extra-gen.mjs
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

async function pumpHunt() {
  const list = await j("/api/live-hunt", {}, 20_000);
  const running = (list.body?.items ?? []).find((h) => h.status === "running");
  let huntId = running?.id ?? null;
  if (!huntId) {
    const start = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "start" }) }, 60_000);
    if (start.status !== 200) { note(false, "hunt start", JSON.stringify(start.body).slice(0, 150)); return null; }
    huntId = start.body.hunt.id;
  }
  const deadline = Date.now() + 540_000;
  let guard = 0;
  while (Date.now() < deadline && guard++ < 450) {
    const r = await j("/api/live-hunt", { method: "POST", body: JSON.stringify({ action: "next", id: huntId }) });
    if (r.status !== 200) {
      note(false, `hunt #${huntId} step`, `${r.status} ${String(r.body?.error ?? "").slice(0, 120)}`);
      return null;
    }
    const h = r.body.hunt;
    if (h.status === "done") {
      note(true, `hunt #${h.id} (gen ${h.generation}) done`, `dna ${h.dnaBefore}→${h.dnaAfter} · llm=${h.llmCalls} · mission=${h.missionId ?? "—"}`);
      return h;
    }
    if (h.status === "failed") { note(false, `hunt #${h.id} failed`, String(h.error ?? "").slice(0, 120)); return null; }
    await sleep(1500);
  }
  note(false, `hunt #${huntId}`, "timeout window — resumable next run");
  return null;
}

async function runHarvest() {
  const r = await j("/api/harvest", { method: "POST", body: JSON.stringify({ maxRepos: 6 }) }, 330_000);
  if (r.status !== 200) { note(false, "harvest", `${r.status} ${String(r.body?.error ?? "").slice(0, 120)}`); return; }
  note(true, "harvest done", `+${r.body.artifactsAdded ?? 0} genes · library=${r.body.totalLibrary ?? "?"} · repos=${(r.body.reposMined ?? []).length}`);
}

async function runSweep() {
  const list = await j("/api/sweep", {}, 20_000);
  let sweepId = list.body?.active?.id ?? null;
  if (sweepId) {
    const active = list.body.items?.find((i) => i.id === sweepId);
    const stale = active?.updatedAt ? Date.now() - new Date(active.updatedAt).getTime() > 10 * 60_000 : false;
    if (stale) {
      note(false, `sweep #${sweepId}`, "zombie detected — marking failed, restarting");
      try {
        const { PrismaClient } = await import("@prisma/client");
        const pdb = new PrismaClient();
        await pdb.sweepRun.updateMany({
          where: { status: "running" },
          data: { status: "failed", error: "run interrupted (server recycled mid-sweep) — auto-marked" },
        });
        await pdb.$disconnect();
      } catch { /* best-effort */ }
      sweepId = null;
    }
  }
  if (!sweepId) {
    const start = await j("/api/sweep", { method: "POST" }, 30_000);
    if (start.status !== 200) { note(false, "sweep start", JSON.stringify(start.body).slice(0, 150)); return; }
    sweepId = start.body.id;
  }
  const deadline = Date.now() + 540_000;
  while (Date.now() < deadline) {
    const r = await j(`/api/sweep/${sweepId}`, {}, 30_000);
    const row = r.body;
    if (row?.status === "done") {
      const st = row.stats ?? {};
      note(true, `sweep #${row.id} done`, `${(row.findings ?? []).length} findings · reposWithFindings=${st.reposWithFindings ?? "?"} · llm=${st.llmCalls ?? 0}`);
      return;
    }
    if (row?.status === "failed") { note(false, `sweep #${sweepId} failed`, String(row.error ?? "").slice(0, 120)); return; }
    await sleep(3000);
  }
  note(false, `sweep #${sweepId}`, "timeout window — resumable next run");
}

// ---- main ----
console.log(`=== extra generation pump ${new Date().toISOString()} ===`);
const up = await j("/api/settings/token", {}, 20_000).catch(() => null);
if (!up || up.status !== 200) {
  console.error("FATAL | server down — run daily-cycle first to cold-start it");
  process.exit(1);
}
if (!(up.body?.hasToken || up.body?.exists)) {
  console.error("FATAL | no GitHub token on server");
  process.exit(1);
}
note(true, "server up + token ready");

const hunt = await pumpHunt();
await runHarvest();
await runSweep();

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const genes = await db.dnaArtifact.count();
await db.$disconnect();
console.log(`EXTRA_GEN_COMPLETE | library=${genes}`);
