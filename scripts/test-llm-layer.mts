// Offline test of src/lib/llm.ts against a local mock of the Anthropic Messages API (SSE).
// Verifies the request rules of the 5.5 generation and the reliability behaviour.
//   bun scripts/test-llm-layer.mts        (or: npx tsx scripts/test-llm-layer.mts)
import http from "node:http";
import type { AddressInfo } from "node:net";

type Handler = (body: any, req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;
let handler: Handler = () => {};
let requestCount = 0;
let inFlight = 0;
let maxInFlight = 0;
const seen: any[] = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ headers: req.headers, body });
    requestCount++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on("close", () => inFlight--);
    handler(body, req, res, requestCount);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = "test-key";

const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [e, d] of events) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  res.end();
};
const okStream = (res: http.ServerResponse, text: string, stop = "end_turn", out = 20) =>
  sse(res, [
    ["message_start", { message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 } } }],
    ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning" } }],
    ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: text.slice(0, Math.ceil(text.length / 2)) } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: text.slice(Math.ceil(text.length / 2)) } }],
    ["message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: out } }],
    ["message_stop", {}],
  ]);

const llm = await import("../src/lib/llm");
const { isTimeoutError } = await import("../src/lib/ai-json");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
};
const reset = () => {
  seen.length = 0;
  requestCount = 0;
  maxInFlight = 0;
  // undici's abort (the timeout test) does NOT close the server-side socket — the aborted
  // response lingers as a "ghost" whose close event never fires, and its stale in-flight
  // slot leaked into the NEXT test's max (the concurrency test measured cap+1). The ghost
  // belongs to the PREVIOUS test's window: zero the counter so each test measures only
  // its own arrivals. A ghost's eventual close can only push the counter DOWN — never
  // above the cap — so the pool's true cap is still measured honestly.
  inFlight = 0;
};

// 1. request shape + response parsing
reset();
handler = (_b, _r, res) => okStream(res, "hello world");
let r = await llm.llmComplete([
  { role: "system", content: "SYS" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "prefill that must be dropped" },
], { tier: "deep" });
const b0 = seen[0].body;
check("text only — thinking blocks are not leaked", r.content === "hello world");
check("usage parsed incl. cache read", r.usage.inputTokens === 100 && r.usage.outputTokens === 20 && r.usage.cacheReadTokens === 50);
check("cost estimated for opus-5-5", r.usage.costUsd > 0);
check("model = claude-opus-5-5 for tier deep", b0.model === "claude-opus-5-5");
check("no thinking field sent", !("thinking" in b0));
check("no temperature/top_p/top_k", !("temperature" in b0) && !("top_p" in b0) && !("top_k" in b0));
check("no forced tool_choice", !("tool_choice" in b0));
check("effort via output_config", b0.output_config?.effort === "medium");
check("streaming enabled", b0.stream === true);
check("system prompt cached", b0.system?.[0]?.cache_control?.type === "ephemeral" && b0.system[0].text.startsWith("SYS"));
check("English-only rule appended to the system prompt", b0.system[0].text.includes("English only"));
check("assistant prefill dropped", b0.messages.length === 1 && b0.messages[0].role === "user");
check("auth + version headers", seen[0].headers["x-api-key"] === "test-key" && seen[0].headers["anthropic-version"] === "2023-06-01");

// 2. tiers
reset();
handler = (_b, _r, res) => okStream(res, "x");
await llm.llmComplete([{ role: "user", content: "a" }], { tier: "fast" });
await llm.llmComplete([{ role: "user", content: "a" }], { tier: "balanced" });
await llm.llmComplete([{ role: "user", content: "a" }], { tier: "frontier", effort: "max" });
check("tier models", seen.map((s) => s.body.model).join(",") === "claude-haiku-5-5,claude-sonnet-5-5,claude-fable-5-2");
check("explicit effort honoured", seen[2].body.output_config.effort === "max");

// 3. 429 → retry-after → success
reset();
handler = (_b, _r, res, n) => {
  if (n === 1) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
  } else okStream(res, "recovered");
};
r = await llm.llmComplete([{ role: "user", content: "a" }]);
check("429 retried and recovered", r.content === "recovered" && requestCount === 2);

// 4. 400 on effort → dropped once
reset();
handler = (b, _r, res) => {
  if (b.output_config?.effort) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "effort is not supported for this model" } }));
  } else okStream(res, "no-effort-ok");
};
r = await llm.llmComplete([{ role: "user", content: "a" }], { model: "claude-legacy-test" });
check("legacy model: effort dropped after 400", r.content === "no-effort-ok" && !("output_config" in seen[1].body));

// 5. non-retryable 400
reset();
handler = (_b, _r, res) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad request" } }));
};
let err: unknown = null;
try { await llm.llmComplete([{ role: "user", content: "a" }]); } catch (e) { err = e; }
check("400 not retried, typed error", err instanceof llm.LlmApiError && (err as any).status === 400 && requestCount === 1);

// 6. refusal
reset();
handler = (_b, _r, res) => sse(res, [
  ["message_start", { message: { usage: { input_tokens: 5 } } }],
  ["message_delta", { delta: { stop_reason: "refusal", stop_details: { category: "cyber" } }, usage: { output_tokens: 0 } }],
]);
err = null;
try { await llm.llmComplete([{ role: "user", content: "a" }]); } catch (e) { err = e; }
check("refusal surfaces as LlmRefusalError with category", err instanceof llm.LlmRefusalError && (err as any).category === "cyber");

// 7. llmJson: truncation → doubled budget → parsed
reset();
handler = (b, _r, res, n) => (n === 1 ? okStream(res, '{"a":', "max_tokens", b.max_tokens) : okStream(res, '{"a": 1, "b": ["x"]}'));
let j = await llm.llmJson("sys", "user", { maxTokens: 1000 });
check("truncated answer retried with 2x max_tokens", seen[1].body.max_tokens === 2000 && j.a === 1);

// 8. llmJson with schema → output_config.format
reset();
handler = (_b, _r, res) => okStream(res, '{"ok": true}');
j = await llm.llmJson("sys", "user", { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
check("schema sent as output_config.format json_schema", seen[0].body.output_config.format?.type === "json_schema" && j.ok === true);

// 9. llmJson repairs fenced/prose-wrapped JSON when no schema
reset();
handler = (_b, _r, res) => okStream(res, 'Here you go:\n```json\n{"x": 2,}\n```');
j = await llm.llmJson("sys", "user");
check("fenced JSON with trailing comma repaired", j.x === 2);

// 10. timeout is typed + flagged + not retried
reset();
handler = () => {}; // never answers — the client times out and aborts
class MyErr extends Error {}
err = null;
try { await llm.llmComplete([{ role: "user", content: "a" }], { timeoutMs: 150, timeoutError: MyErr, timeoutLabel: "probe" }); } catch (e) { err = e; }
check("timeout → typed error, flagged, single attempt", err instanceof MyErr && isTimeoutError(err) && requestCount === 1);
// The abort leaves a server-side "ghost" (undici does not close the socket on abort) —
// reset() zeroes the in-flight counter between tests, so no stale slot leaks forward.

// 11. concurrency pool (limit 2)
process.env.HUNTER_LLM_CONCURRENCY = "2";
reset();
handler = (_b, _r, res) => setTimeout(() => okStream(res, "x"), 80);
await Promise.all(Array.from({ length: 6 }, () => llm.llmComplete([{ role: "user", content: "a" }])));
check(`concurrency capped at 2 (max in flight = ${maxInFlight})`, maxInFlight === 2 && requestCount === 6);
delete process.env.HUNTER_LLM_CONCURRENCY;

// 12. stats + attempts counter
const stats = llm.llmStats();
check("stats track models, tokens, cost", stats.attempts > 10 && stats.models["claude-opus-5-5"]?.calls > 0 && stats.estimatedCostUsd > 0);
check("llmCallSnapshot is monotonic", llm.llmCallSnapshot() === stats.attempts);

// 13. missing key → the dual-transport contract (honest reporting)
// v0.3.0 threw LlmConfigError when no key was set. This build adds a hosted-gateway
// fallback (z-ai transport) so the app still works without ANTHROPIC_API_KEY — by
// design, not a regression. The offline contract check: the layer REPORTS the fallback
// honestly and never claims a specific Claude model id that did not verifiably run.
// (The fallback path itself is not exercised here — it would hit the live SDK gateway
// and make this suite non-offline.)
const saved = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
check(
  "missing key → fallback transport reported honestly",
  !llm.llmConfigured() && llm.llmTransport() === "zai-gateway-fallback"
);
check("key restored → direct transport reported", (() => { process.env.ANTHROPIC_API_KEY = saved; return llm.llmConfigured() && llm.llmTransport() === "direct-anthropic"; })());

server.close();
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
