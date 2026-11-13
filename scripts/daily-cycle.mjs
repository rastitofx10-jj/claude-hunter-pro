#!/usr/bin/env node
/**
 * daily-cycle.mjs — the self-healing daily intelligence cycle.
 *
 * One run = restore-if-empty → token → hunt → harvest → sweep → license
 * backfill → snapshot → (optional) report. Every phase is resumable and a
 * failure in one phase never kills the rest: the loop catches, logs, and
 * moves on, so a partial cycle still snapshots what it got.
 *
 * Why this exists: the time-series IS the moat. Every day without a run is a
 * permanent hole in the ecosystem history that can never be filled later.
 *
 * Usage:
 *   node scripts/daily-cycle.mjs           # full cycle
 *   node scripts/daily-cycle.mjs --quick   # hunt only (skip harvest+sweep)
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quick = process.argv.includes("--quick");
const results = [];
const note = (ok, label, detail = "") => {
  results.push(`${ok ? "PASS" : "WARN"} | ${label}${detail ? ` | ${detail}` : ""}`);
  console.log(results[results.length - 1]);
};

const j = async (path, init, timeoutMs = 320_000) => {
  // one retry on transient network errors — undici's default headers-timeout is 300s,
  // and a cold dev-server compiling a route can hold a request open that long.
  // round 8 (two fixes):
  //  a) the regex was case-sensitive — AbortSignal.timeout() rejects with a DOMException
  //     whose .name is "TimeoutError", which /TIMEOUT/ never matched, so the script's OWN
  //     timeouts never retried. Now case-insensitive.
  //  b) the retry re-issued non-idempotent POSTs (harvest burns quota, hunt "next" can
  //     double-advance a step). Now only GETs retry; a failed POST surfaces honestly.
  const method = (init?.method ?? "GET").toUpperCase();
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
  try {
    return await once();
  } catch (e) {
    const name = e?.cause?.code ?? e?.code ?? e?.name ?? "";
    if (method !== "GET" || !/timeout|econn|eai_again|socket/i.test(String(name))) throw e;
    await sleep(8000);
    return await once();
  }
};

async function countGenes() {
  const r = await j("/api/dna-library", {}, 20_000);
  const items = r.body?.items ?? [];
  return Array.isArray(items) ? items.length : 0;
}

// daily state — each phase runs ONCE per day; re-runs only resume what was cut off
const STATE_FILE = "/home/z/my-project/.cycle-state.json";
const loadState = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
};
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), "utf8");
const doneToday = (ts) => {
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() < 20 * 3600_000; // 20h window ≈ "once a day"
};

async function ensureToken() {
  let r = await j("/api/settings/token", {}, 20_000).catch(() => null);
  // API returns {exists, masked, updatedAt} — accept both shapes (older drafts said hasToken)
  if (r?.body?.hasToken || r?.body?.exists) return true;
  // post-recycle: store from upload file.
  // round 8: this looked for a Hebrew-named file that does NOT exist on disk
  // (the real file is upload/token.secret — the name hunt-live.mjs uses). The result:
  // after every env recycle (PAT lives in the DB, dna-restore deliberately skips it)
  // ensureToken() → DB empty → fallback missing → FATAL — the self-healing cycle died
  // at step 1, BEFORE the restore step ever ran. Now: both known names, absolute paths.
  const candidates = ["/home/z/my-project/upload/token.secret", "/home/z/my-project/upload/טוקן טיטפקס10.secret"];
  const found = candidates.find((f) => existsSync(f));
  if (!found) return false;
  const raw = readFileSync(found, "utf8").trim();
  if (raw.length < 20) return false;
  const s = await j("/api/settings/token", { method: "POST", body: JSON.stringify({ token: raw }) }, 30_000);
  return s.status === 200;
}

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
  // zombie guard: a sweep whose server died mid-run stays "running" forever.
  // updatedAt older than 10 min while claiming to run = dead → mark failed, restart.
  if (sweepId) {
    const active = list.body.items?.find((i) => i.id === sweepId);
    const stale = active?.updatedAt ? Date.now() - new Date(active.updatedAt).getTime() > 10 * 60_000 : false;
    if (stale) {
      note(false, `sweep #${sweepId}`, "zombie detected (no progress 10 min) — marking failed, restarting");
      try {
        const { PrismaClient } = await import("@prisma/client");
        const pdb = new PrismaClient();
        await pdb.sweepRun.updateMany({
          where: { status: "running" },
          data: { status: "failed", error: "run interrupted (server recycled mid-sweep) — auto-marked" },
        });
        await pdb.$disconnect();
      } catch { /* DB fix best-effort */ }
      sweepId = null;
    }
  }
  if (!sweepId) {
    const start = await j("/api/sweep", { method: "POST" }, 30_000);
    if (start.status !== 200) { note(false, "sweep start", JSON.stringify(start.body).slice(0, 150)); return; }
    sweepId = start.body.id;
  }
  const deadline = Date.now() + 540_000;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const r = await j(`/api/sweep/${sweepId}`, {}, 30_000);
    const row = r.body;
    if (row?.phase !== lastPhase) { lastPhase = row?.phase ?? "?"; }
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

function sh(cmd) {
  try { return { ok: true, out: execSync(cmd, { cwd: "/home/z/my-project", stdio: ["pipe", "pipe", "pipe"] }).toString().trim() }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? e.message).trim().slice(0, 200) }; }
}

// ---------- the cycle ----------
(async () => {
  console.log(`=== daily cycle ${new Date().toISOString()} ${quick ? "(quick)" : ""} ===`);

  // 0) server alive? if not — cold-start it (env recycles kill background processes;
  //    each runner call owns its server lifetime: dies with this process, DB keeps state)
  let alive = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
  let serverProc = null;
  if (!alive) {
    console.log("server down — cold-starting dev server…");
    serverProc = spawn("bun", ["run", "dev"], { cwd: "/home/z/my-project", stdio: "ignore", detached: false });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      alive = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
      if (alive) break;
    }
  }
  if (!alive) { console.error("FATAL | dev server would not start on :3000"); process.exit(1); }
  note(true, "server up");

  // 1) token
  if (!(await ensureToken())) { console.error("FATAL | no GitHub token (DB or upload file)"); process.exit(1); }
  note(true, "token ready");

  // 1.5) restore-if-thin — env recycles wipe db/custom.db; the git snapshot is the
  //      source of truth. Idempotent upserts: a full DB gains nothing, a wiped DB
  //      gets the whole library back (incl. hunt history → generation continuity).
  // round 8: the old catch conflated "snapshot missing (first run)" with "snapshot
  //      CORRUPT/UNREADABLE" — a corrupt read set snapGenes=0, which silently disabled
  //      BOTH the restore trigger AND the never-regress guard, so the cycle ran on a
  //      thin DB and dna-snapshot.mjs overwrote the 20MB source-of-truth with the thin
  //      library. Fail closed now: missing → 0 (first run); corrupt → refuse to snapshot.
  let snapGenes = 0;
  let snapUnreadable = false;
  try {
    snapGenes = JSON.parse(readFileSync("/home/z/my-project/reports/state/dna-snapshot.json", "utf8")).counts?.dnaArtifacts ?? 0;
  } catch (e) {
    const code = e?.code ?? "";
    if (code !== "ENOENT") snapUnreadable = true; // corrupt/partial file — NOT a first run
  }
  if (snapUnreadable) {
    note(false, "snapshot guard", "dna-snapshot.json unreadable (corrupt?) — snapshot phase SKIPPED to protect the committed library; investigate before next cycle");
  }
  if (snapGenes > (await countGenes().catch(() => 0))) {
    const r = sh("node scripts/dna-restore.mjs");
    note(r.ok, "restore", r.out.split("\n")[0] ?? "");
  }

  const genesBefore = await countGenes().catch(() => 0);
  const state = loadState();

  // every phase is isolated: a failure logs WARN and the cycle moves on
  const phase = async (name, fn) => {
    try { await fn(); } catch (e) { note(false, name, `unhandled: ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 140)}`); }
  };

  // 2) hunt (the engine that compounds generations) — once per day
  if (doneToday(state.lastHuntDone)) {
    note(true, "hunt", `skipped — already ran today (${String(state.lastHuntDone).slice(0, 16)})`);
  } else {
    await phase("hunt", pumpHunt);
    // mark done only if the hunt actually finished (pumpHunt notes PASS with "done")
    const huntDone = results.some((r) => r.startsWith("PASS") && /hunt #\d+ \(gen \d+\) done/.test(r));
    if (huntDone) { state.lastHuntDone = new Date().toISOString(); saveState(state); }
  }

  // 3) quota window — search quota refills ~30/min; one sleep covers the burst
  if (!doneToday(state.lastHuntDone)) await sleep(60_000);

  // 4) harvest + sweep — once per day each
  if (doneToday(state.lastHarvestDone)) {
    note(true, "harvest", `skipped — already ran today (${String(state.lastHarvestDone).slice(0, 16)})`);
  } else {
    await phase("harvest", runHarvest);
    if (results.some((r) => r.startsWith("PASS") && r.includes("harvest done"))) {
      state.lastHarvestDone = new Date().toISOString(); saveState(state);
    }
  }
  await sleep(30_000);
  if (doneToday(state.lastSweepDone)) {
    note(true, "sweep", `skipped — already ran today (${String(state.lastSweepDone).slice(0, 16)})`);
  } else {
    await phase("sweep", runSweep);
    if (results.some((r) => r.startsWith("PASS") && /sweep #\d+ done/.test(r))) {
      state.lastSweepDone = new Date().toISOString(); saveState(state);
    }
  }

  // 5) license backfill (any gene born without a license)
  const bf = sh("node scripts/license-backfill.mjs");
  note(bf.ok, "license backfill", bf.out.split("\n")[0] ?? "");

  // 5.5) findings desk — WO2 of chimera #3: the standing review window over the
  // sweep-findings queue. Runs EVERY cycle (a desk, not an event); drains the
  // queue within one tick; idempotent (reviewed repos re-enter only after 30d).
  const desk = sh("node scripts/findings-desk.mjs");
  note(desk.ok, "findings desk", (desk.out.split("\n").find((l) => l.startsWith("DESK_TICK_DONE")) ?? desk.out.split("\n")[0] ?? ""));

  const genesAfter = await countGenes().catch(() => genesBefore);

  // 6) snapshot to git (survives env recycles) — never regress: if the DB holds
  //    fewer genes than the committed snapshot, snapshotting would erase history
  if (snapUnreadable) {
    note(false, "snapshot", "skipped — source snapshot unreadable this cycle (fail closed; see snapshot guard above)");
  } else if (genesAfter < snapGenes) {
    note(false, "snapshot", `refused — db ${genesAfter} < snapshot ${snapGenes} genes; would erase history`);
  } else {
    const snap = sh("node scripts/dna-snapshot.mjs");
    note(snap.ok, "snapshot", snap.out.split("\n")[0] ?? "");

    // 7) radar report — the artifact that leaves the system (only over a full library)
    const radar = sh("node scripts/radar-report.mjs");
    note(radar.ok, "radar report", radar.out.split("\n")[0] ?? "");
  }
  note(
    results.every((r) => r.startsWith("PASS")),
    "cycle summary",
    `genes ${genesBefore} → ${genesAfter} (${genesAfter - genesBefore >= 0 ? "+" : ""}${genesAfter - genesBefore})`
  );
  console.log(results.join("\n"));
  // free the owned server (if we started it) — next run re-spawns as needed
  if (serverProc) { try { serverProc.kill(); } catch { /* already gone */ } }
  console.log("CYCLE_COMPLETE");
  // Round 9 — honest exit code. The old rule (`WARN && genes didn't grow`) masked
  // real failures whenever the harvest happened to add genes: restore FAILed +
  // hunt FAILed + snapshot REFUSED all exited 0, cron never saw a non-zero exit,
  // and genes that were never snapshotted could be lost permanently at the next
  // env recycle. Now: exit 1 on ANY severe WARN — the restore, hunt, sweep, or
  // snapshot steps failing is a red day regardless of gene growth (findings-desk /
  // license-backfill / radar WARNs stay non-fatal, same as before).
  const SEVERE = /^\s*WARN\s*\|\s*(restore|hunt|sweep|snapshot|db)/i;
  const severeWarn = results.some((r) => SEVERE.test(r));
  if (severeWarn) {
    console.error("CYCLE_EXIT=1 (severe WARN — restore/hunt/sweep/snapshot/db; see lines above)");
  }
  process.exit(severeWarn ? 1 : 0);
})();
