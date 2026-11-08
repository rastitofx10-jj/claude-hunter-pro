// מנהל ריצה עבור Gen 7 — מריץ start ואז next בלולאה עד לסיום.
// המצב נשמר ב-DB לכל שלב, ולכן ניתן להמשיך מכל נקודה גם אם הסקריפט נחתך.
const BASE = "http://localhost:3000/api/live-hunt";
const startRes = await fetch(BASE, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "start" }),
});
const startJson = await startRes.json();
if (startJson.error) { console.log("START_FAIL:", startJson.error); process.exit(1); }
const id = startJson.hunt.id;
console.log("STARTED_HUNT:", id, "| gen:", startJson.hunt.generation);

for (let i = 0; i < 15; i++) {
  try {
    const r = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "next", id }),
      signal: AbortSignal.timeout(430_000),
    });
    const j = await r.json();
    if (j.error) { console.log("STEP_ERROR:", j.error); break; }
    const h = j.hunt;
    const stages = Array.isArray(h.stages) ? h.stages : [];
    const last = stages[stages.length - 1];
    console.log(`STAGE_DONE: ${last?.key ?? "?"} (${Math.round((last?.ms ?? 0) / 1000)}s) | next=${h.stageKey} | status=${h.status} | dna:${h.dnaBefore}->${h.dnaAfter} | llm=${h.llmCalls}`);
    if (h.status === "done" || h.status === "failed") { console.log("FINAL:", h.status, "| missionId:", h.missionId); break; }
  } catch (e) {
    console.log("TIMEOUT_OR_NET:", e.message ?? e, "— המצב ב-DB, אפשר להמשיך");
    break;
  }
}
