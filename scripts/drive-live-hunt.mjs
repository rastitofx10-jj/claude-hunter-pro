// Drives a full Live Hunt chain end-to-end through the official API:
// start → next until done/failed. Prints every stage transition + verdict.
const BASE = "http://localhost:3000";

async function post(body) {
  const res = await fetch(`${BASE}/api/live-hunt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { status: res.status, j };
}

async function main() {
  const t0 = Date.now();
  const start = await post({ action: "start" });
  if (start.status !== 200) {
    console.log("START FAILED", JSON.stringify(start.j).slice(0, 400));
    process.exit(1);
  }
  const id = start.j.hunt?.id;
  console.log(`[hunt #${id}] started — driving the full kill chain`);

  let guard = 0;
  let lastStage = "";
  while (guard++ < 80) {
    // the execute stage runs one autopilot phase per call — keep pumping "next"
    const r = await post({ action: "next", id });
    if (r.status !== 200) {
      console.log("NEXT FAILED", JSON.stringify(r.j).slice(0, 500));
      break;
    }
    const h = r.j.hunt ?? {};
    const stage = h.stageKey ?? "?";
    const status = h.status ?? "?";
    if (stage !== lastStage) {
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] stage=${stage} status=${status} mission=${h.missionId ?? "-"} dna=${h.dnaBefore}→${h.dnaAfter}`);
      lastStage = stage;
    }
    if (status === "done" || status === "failed") {
      console.log(`CHAIN ${status.toUpperCase()} after ${Math.round((Date.now() - t0) / 1000)}s`);
      const stages = Array.isArray(h.stages) ? h.stages : [];
      for (const s of stages) console.log(`    - ${s.key}: ${String(s.summary ?? "").slice(0, 160)}`);
      if (h.error) console.log("    error:", String(h.error).slice(0, 300));
      break;
    }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  process.exit(0);
}

main();
