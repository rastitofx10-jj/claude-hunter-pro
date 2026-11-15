// Round 13 test — kept in the repo's suite (runs standalone, no network)
// Round 13: verifies the no-token fail-fast guards (hunt / sweep / harvest) —
// the exact error the user hit before the token was stored must be clear and instant.
let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} | ${name}`); };

const { harvest } = await import("../src/lib/harvester.ts");
const { beginSweep } = await import("../src/lib/sweep-runner.ts");

// harvest: null/empty/whitespace tokens all refused with the precise message + 400
for (const t of [null, "", "   "]) {
  try {
    await harvest(t, 1);
    check(`harvest(${JSON.stringify(t)}): refused`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const status = (e as Error & { status?: number }).status;
    check(`harvest(${JSON.stringify(t)}): 400 + actionable message`, msg.includes("No GitHub token") && status === 400);
  }
}

// beginSweep: same contract (checks BEFORE the 409/DB path — a token-less sweep
// never even creates a run row)
for (const t of [null, "", "   "]) {
  try {
    await beginSweep(t);
    check(`beginSweep(${JSON.stringify(t)}): refused`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const status = (e as Error & { status?: number }).status;
    const notRunning = !msg.includes("already running");
    check(`beginSweep(${JSON.stringify(t)}): 400 + actionable message`, notRunning && msg.includes("No GitHub token") && status === 400);
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
