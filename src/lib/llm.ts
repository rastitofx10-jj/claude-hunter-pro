// ============================================================
// Claude API layer — the single gateway for every LLM call in the app.
//
// Replaces the old z-ai-web-dev-sdk queue. Talks to the Anthropic Messages
// API directly over fetch (zero SDK dependency, streaming SSE) and follows the
// request rules of the current model generation (Opus 5.5 / Sonnet 5.5 /
// Haiku 5.5 / Fable 5.2):
//
//   * no `thinking` field   — adaptive thinking is always on, `thinking:
//                              {type:"disabled"}` is a 400 on Opus 5.5
//   * `output_config.effort` — the only control for thinking depth
//   * no temperature/top_p/top_k, no assistant prefill, no forced tool_choice
//   * structured JSON via `output_config.format` (json_schema) — never via
//     forced tool use
//   * content is read by block `type` (thinking blocks come first)
//   * `max_tokens` covers thinking + answer, so budgets are generous
//   * always streamed — long adaptive-thinking requests never sit on a silent
//     socket
//
// Reliability: bounded concurrency pool (not a concurrency-1 queue), retry with
// exponential backoff + jitter that honors `retry-after` on 429/5xx/529,
// per-attempt timeout (never retried — same result, wasted minutes), one-shot
// capability fallback if an overridden legacy model rejects `effort`/schema,
// truncation recovery (max_tokens → retry with a larger budget), refusal
// detection, token + cost accounting.
//
// Server-side only. Configure through environment variables — see .env.example.
// ============================================================

import { extractJson, markTimeoutError, type ErrorFactory } from "./ai-json";
import { llmComplete as zaiComplete, llmCallSnapshot as zaiAttemptSnapshot } from "./zai";

// ---------- types ----------

export type LlmTier = "frontier" | "deep" | "balanced" | "fast";
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  /** Which model tier to run on. Default "deep" (Opus 5.5). */
  tier?: LlmTier;
  /** Explicit model id — overrides the tier. */
  model?: string;
  /** Thinking depth. Default depends on the tier. */
  effort?: LlmEffort;
  /** Output ceiling (thinking + answer). Default 16_000. */
  maxTokens?: number;
  /** Per-attempt wall-clock timeout. Default 240_000. */
  timeoutMs?: number;
  /** Human label used in error messages and stats. */
  timeoutLabel?: string;
  /** Error class used for timeouts / parse failures so upper layers keep their typed errors. */
  timeoutError?: ErrorFactory;
  /** JSON Schema for structured outputs (every object needs additionalProperties:false). */
  schema?: Record<string, unknown>;
  /** Cache the system prompt (default true; ignored by the API below the minimum prompt length). */
  cacheSystem?: boolean;
  /** Abort from the caller side. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface LlmResult {
  content: string;
  model: string;
  stopReason: string | null;
  usage: LlmUsage;
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export class LlmApiError extends Error {
  status: number;
  type: string;
  retryAfterMs: number | null;
  constructor(message: string, status: number, type = "api_error", retryAfterMs: number | null = null) {
    super(message);
    this.name = "LlmApiError";
    this.status = status;
    this.type = type;
    this.retryAfterMs = retryAfterMs;
  }
}

export class LlmRefusalError extends Error {
  category: string | null;
  constructor(message: string, category: string | null) {
    super(message);
    this.name = "LlmRefusalError";
    this.category = category;
  }
}

export class LlmTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTruncatedError";
  }
}

// ---------- model catalog ----------

interface ModelPricing {
  /** USD per million tokens */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Published list prices (Claude API). Cache rates for non-Opus models are estimates. */
const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.4 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.005 },
};

const DEFAULT_MODELS: Record<LlmTier, string> = {
  frontier: "claude-fable-5-2",
  deep: "claude-opus-5-5",
  balanced: "claude-sonnet-5-5",
  fast: "claude-haiku-5-5",
};

const DEFAULT_EFFORT: Record<LlmTier, LlmEffort> = {
  frontier: "high",
  deep: "medium",
  balanced: "medium",
  fast: "low",
};

export function modelForTier(tier: LlmTier): string {
  const env = process.env[`HUNTER_MODEL_${tier.toUpperCase()}`]?.trim();
  return env || DEFAULT_MODELS[tier];
}

function pricingFor(model: string): ModelPricing | null {
  if (PRICING[model]) return PRICING[model];
  // snapshot ids / bedrock-style prefixes: match on the family-version stem
  const hit = Object.keys(PRICING).find((k) => model.includes(k));
  return hit ? PRICING[hit] : null;
}

// ---------- configuration ----------

const API_VERSION = "2023-06-01";

function apiKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  if (!k) {
    throw new LlmConfigError(
      "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) and restart the server."
    );
  }
  return k;
}

function baseUrl(): string {
  return (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
}

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** The transport actually serving calls right now — reported honestly, never as a specific Claude id. */
export function llmTransport(): "direct-anthropic" | "zai-gateway-fallback" {
  return llmConfigured() ? "direct-anthropic" : "zai-gateway-fallback";
}

function concurrencyLimit(): number {
  const n = Number(process.env.HUNTER_LLM_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 16) : 4;
}

const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- concurrency pool ----------

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < concurrencyLimit()) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

// ---------- instrumentation ----------

let attemptsTotal = 0;

interface ModelStats {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

const statsByModel = new Map<string, ModelStats>();
let lastError: { at: string; message: string } | null = null;

function bump(model: string, u: LlmUsage | null, failed: boolean): void {
  const s =
    statsByModel.get(model) ??
    { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  s.calls++;
  if (failed) s.failures++;
  if (u) {
    s.inputTokens += u.inputTokens;
    s.outputTokens += u.outputTokens;
    s.cacheWriteTokens += u.cacheWriteTokens;
    s.cacheReadTokens += u.cacheReadTokens;
    s.costUsd += u.costUsd;
  }
  statsByModel.set(model, s);
}

/** Monotonic count of real API attempts (retries included, BOTH transports) — used by live-hunt stage accounting. */
export function llmCallSnapshot(): number {
  return attemptsTotal + zaiAttemptSnapshot();
}

/** Process-wide usage snapshot for the status endpoint and stage evidence. */
export function llmStats() {
  const models = Object.fromEntries(
    Array.from(statsByModel.entries()).map(([k, v]) => [k, { ...v, costUsd: Number(v.costUsd.toFixed(4)) }])
  );
  const totalCost = Array.from(statsByModel.values()).reduce((a, s) => a + s.costUsd, 0);
  return {
    transport: llmTransport(),
    attempts: attemptsTotal + zaiAttemptSnapshot(),
    inFlight: active,
    queued: waiters.length,
    estimatedCostUsd: Number(totalCost.toFixed(4)),
    models,
    lastError,
  };
}

// ---------- request building ----------

interface ApiBody {
  model: string;
  max_tokens: number;
  stream: true;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  output_config?: { effort?: LlmEffort; format?: { type: "json_schema"; schema: Record<string, unknown> } };
}

/** Appended to every system prompt: mined repos contain every language, the product speaks English only. */
export const ENGLISH_ONLY_RULE =
  "Language rule: write every output in English only — including JSON string values, markdown files, names and notes — even when the input, the evidence or the source repositories are written in another language. Quote non-English source text only when it is essential evidence, and translate it.";

function splitMessages(messages: LlmMessage[]): { system: string; turns: ApiBody["messages"] } {
  const system = [
    ...messages.filter((m) => m.role === "system").map((m) => m.content),
    ENGLISH_ONLY_RULE,
  ]
    .join("\n\n")
    .trim();
  const turns: ApiBody["messages"] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  if (turns.length === 0 || turns[0].role !== "user") {
    throw new LlmConfigError("An LLM request needs at least one user message and must start with a user turn.");
  }
  // Prefill is rejected by current models — a trailing assistant turn is never sent.
  while (turns.length > 0 && turns[turns.length - 1].role === "assistant") turns.pop();
  return { system, turns };
}

function buildBody(
  model: string,
  system: string,
  turns: ApiBody["messages"],
  maxTokens: number,
  effort: LlmEffort | null,
  schema: Record<string, unknown> | null,
  cacheSystem: boolean
): ApiBody {
  const body: ApiBody = { model, max_tokens: maxTokens, stream: true, messages: turns };
  if (system) {
    body.system = [{ type: "text", text: system, ...(cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}) }];
  }
  if (effort || schema) {
    body.output_config = {};
    if (effort) body.output_config.effort = effort;
    if (schema) body.output_config.format = { type: "json_schema", schema };
  }
  return body;
}

// ---------- SSE streaming ----------

interface StreamOutcome {
  text: string;
  stopReason: string | null;
  refusalCategory: string | null;
  usage: LlmUsage;
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function readStream(res: Response, model: string): Promise<StreamOutcome> {
  if (!res.body) throw new LlmApiError("The API returned an empty stream", 502, "empty_stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let stopReason: string | null = null;
  let refusalCategory: string | null = null;
  let inTok = 0;
  let outTok = 0;
  let cacheW = 0;
  let cacheR = 0;
  const textBlocks = new Set<number>();

  const handle = (evt: string, data: string) => {
    // SSE payloads are open shapes — parsed loosely on purpose
    let j: Record<string, any>;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    switch (evt) {
      case "message_start": {
        const u = j.message?.usage ?? {};
        inTok = u.input_tokens ?? 0;
        cacheW = u.cache_creation_input_tokens ?? 0;
        cacheR = u.cache_read_input_tokens ?? 0;
        outTok = u.output_tokens ?? 0;
        break;
      }
      case "content_block_start":
        if (j.content_block?.type === "text") {
          textBlocks.add(j.index);
          if (typeof j.content_block.text === "string") text += j.content_block.text;
        }
        break;
      case "content_block_delta":
        // thinking blocks (type "thinking") are intentionally ignored — only text is the answer
        if (j.delta?.type === "text_delta" && textBlocks.has(j.index)) text += j.delta.text ?? "";
        break;
      case "message_delta":
        if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
        if (j.delta?.stop_details?.category) refusalCategory = j.delta.stop_details.category;
        if (j.usage?.output_tokens != null) outTok = j.usage.output_tokens;
        if (j.usage?.input_tokens != null) inTok = j.usage.input_tokens;
        break;
      case "error": {
        const e = j.error ?? {};
        throw new LlmApiError(e.message ?? "stream error", e.type === "overloaded_error" ? 529 : 500, e.type ?? "stream_error");
      }
      default:
        break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: !done });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evt = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) evt = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) handle(evt, dataLines.join("\n"));
    }
    if (done) break;
  }

  const p = pricingFor(model);
  const costUsd = p
    ? (inTok * p.input + outTok * p.output + cacheW * p.cacheWrite + cacheR * p.cacheRead) / 1_000_000
    : 0;
  return {
    text,
    stopReason,
    refusalCategory,
    usage: { inputTokens: inTok, outputTokens: outTok, cacheWriteTokens: cacheW, cacheReadTokens: cacheR, costUsd },
  };
}

// ---------- one attempt ----------

async function attemptOnce(body: ApiBody, timeoutMs: number, external?: AbortSignal): Promise<StreamOutcome> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => ctrl.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(`${baseUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let type = "api_error";
      try {
        const j = (await res.json()) as { error?: { type?: string; message?: string } };
        message = j.error?.message ?? message;
        type = j.error?.type ?? type;
      } catch {
        // non-JSON error body
      }
      throw new LlmApiError(message, res.status, type, parseRetryAfter(res.headers.get("retry-after")));
    }
    return await readStream(res, body.model);
  } catch (e) {
    if (timedOut) throw new TimeoutSignal();
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

class TimeoutSignal extends Error {}

function retryable(e: unknown): boolean {
  if (e instanceof LlmApiError) return e.status === 429 || e.status === 529 || e.status >= 500 || e.status === 408;
  // network-level failures from fetch (reset, DNS, TLS) surface as TypeError
  return e instanceof TypeError;
}

function looksLikeCapabilityReject(e: unknown): "effort" | "format" | null {
  if (!(e instanceof LlmApiError) || e.status !== 400) return null;
  const m = e.message.toLowerCase();
  if (/effort/.test(m)) return "effort";
  if (/output_config|json_schema|structured/.test(m)) return "format";
  return null;
}

// ---------- public API ----------

/**
 * One Claude call through the bounded pool. Returns the answer text (empty string if
 * the model produced no text block) plus usage. Throws:
 *   LlmConfigError  — missing key / bad request shape
 *   LlmApiError     — non-retryable API error, or retries exhausted
 *   LlmRefusalError — the model declined (stop_reason "refusal")
 *   opts.timeoutError (default Error), flagged with markTimeoutError — attempt timed out
 */
export async function llmComplete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<LlmResult> {
  const tier = opts.tier ?? "deep";
  const model = opts.model ?? modelForTier(tier);
  let effort: LlmEffort | null = opts.effort ?? DEFAULT_EFFORT[tier];
  let schema: Record<string, unknown> | null = opts.schema ?? null;
  const maxTokens = opts.maxTokens ?? 16_000;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const label = opts.timeoutLabel ?? "AI call";
  const Err: ErrorFactory = opts.timeoutError ?? Error;
  const { system, turns } = splitMessages(messages);

  // ---------- Fallback transport (no ANTHROPIC_API_KEY) ----------
  // When no key is configured (e.g. this sandbox): the hosted gateway
  // (z-ai-web-dev-sdk) serves the call.
  // HONEST reporting: the tier/effort/schema knobs are prompt-level intent only
  // here (that endpoint decides which model actually runs), so the result's
  // model field carries the gateway marker — never a specific Claude id that
  // was not verifiably used. The English-only rule still applies (prompt-level,
  // transport-independent). Usage stats are recorded under the gateway marker.
  if (!llmConfigured()) {
    const marker = `zai-gateway(tier:${tier})`;
    try {
      const r = await zaiComplete(
        system ? [{ role: "system", content: system }, ...turns] : turns,
        { timeoutMs, timeoutLabel: label, timeoutError: Err }
      );
      bump(marker, null, false);
      return {
        content: r.content,
        model: marker,
        stopReason: null, // the fallback transport does not expose stop reasons
        usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      };
    } catch (e) {
      bump(marker, null, true);
      lastError = { at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  }

  await acquire();
  try {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attemptsTotal++;
      try {
        const body = buildBody(model, system, turns, maxTokens, effort, schema, opts.cacheSystem !== false);
        const out = await attemptOnce(body, timeoutMs, opts.signal);
        bump(model, out.usage, false);
        if (out.stopReason === "refusal") {
          throw new LlmRefusalError(
            `The model declined this request${out.refusalCategory ? ` (${out.refusalCategory})` : ""}`,
            out.refusalCategory
          );
        }
        return { content: out.text, model, stopReason: out.stopReason, usage: out.usage };
      } catch (e) {
        lastErr = e;
        if (e instanceof TimeoutSignal) {
          bump(model, null, true);
          lastError = { at: new Date().toISOString(), message: `${label} timed out` };
          // typed timeout, flagged so upper layers never retry it
          throw markTimeoutError(new Err(`${label} timed out`));
        }
        if (e instanceof LlmRefusalError || e instanceof LlmConfigError) {
          bump(model, null, true);
          throw e;
        }
        // an overridden/legacy model that rejects `effort` or json_schema: drop it once and go again
        const cap = looksLikeCapabilityReject(e);
        if (cap === "effort" && effort) {
          effort = null;
          continue;
        }
        if (cap === "format" && schema) {
          schema = null;
          continue;
        }
        if (retryable(e) && attempt < MAX_ATTEMPTS - 1) {
          const base = e instanceof LlmApiError && e.retryAfterMs != null ? e.retryAfterMs : 1_000 * 2 ** attempt;
          await sleep(Math.min(60_000, base) + Math.floor(Math.random() * 400));
          continue;
        }
        bump(model, null, true);
        lastError = { at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) };
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
  } finally {
    release();
  }
}

/**
 * A JSON-returning Claude call. With `schema`, uses structured outputs (guaranteed valid
 * JSON); without, falls back to prompt-driven JSON plus the repair chain in ai-json.ts.
 * If the answer is cut off by max_tokens it retries once with double the budget (cap 64k).
 */
export async function llmJson(
  system: string,
  user: string,
  opts: LlmOptions = {}
): Promise<Record<string, unknown>> {
  const Err: ErrorFactory = opts.timeoutError ?? Error;
  let maxTokens = opts.maxTokens ?? 16_000;
  for (let pass = 0; pass < 2; pass++) {
    const res = await llmComplete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { ...opts, maxTokens }
    );
    if (res.stopReason === "max_tokens" && pass === 0 && maxTokens < 64_000) {
      maxTokens = Math.min(64_000, maxTokens * 2);
      continue;
    }
    if (res.stopReason === "max_tokens") {
      throw new LlmTruncatedError(`${opts.timeoutLabel ?? "AI call"} was cut off at ${maxTokens} tokens`);
    }
    if (!res.content.trim()) throw new Err("The AI returned an empty answer");
    if (opts.schema) {
      try {
        const parsed: unknown = JSON.parse(res.content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // fall through to the repair chain
      }
    }
    return extractJson(res.content, Err);
  }
  throw new Err("The AI returned no usable JSON");
}

/** A plain-text Claude call (markdown documents such as SKILL.md). */
export async function llmText(system: string, user: string, opts: LlmOptions = {}): Promise<string> {
  const res = await llmComplete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    opts
  );
  if (res.stopReason === "max_tokens") {
    throw new LlmTruncatedError(`${opts.timeoutLabel ?? "AI call"} was cut off at ${opts.maxTokens ?? 16_000} tokens`);
  }
  return res.content;
}
