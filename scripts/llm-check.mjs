// Live smoke test of the Claude layer: verifies the API key and every configured tier model
// with a tiny request that follows the current request rules (no thinking field, effort via
// output_config, no sampling params).   Usage:  ANTHROPIC_API_KEY=sk-... node scripts/llm-check.mjs
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  console.error("ANTHROPIC_API_KEY is not set (put it in .env or export it).");
  process.exit(2);
}
const base = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
const tiers = {
  frontier: process.env.HUNTER_MODEL_FRONTIER || "claude-fable-5-2",
  deep: process.env.HUNTER_MODEL_DEEP || "claude-opus-5-5",
  balanced: process.env.HUNTER_MODEL_BALANCED || "claude-sonnet-5-5",
  fast: process.env.HUNTER_MODEL_FAST || "claude-haiku-5-5",
};
let failed = 0;
for (const [tier, model] of Object.entries(tiers)) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with exactly the word: ready" }],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${j?.error?.type ?? ""}: ${j?.error?.message ?? ""}`);
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    console.log(`OK   ${tier.padEnd(9)} ${model.padEnd(20)} ${Date.now() - t0}ms  in=${j.usage?.input_tokens} out=${j.usage?.output_tokens}  → ${JSON.stringify(text)}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${tier.padEnd(9)} ${model.padEnd(20)} ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
