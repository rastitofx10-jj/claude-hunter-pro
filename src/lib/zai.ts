// ============================================================
// Singleton for the AI SDK — a single connection source + a global queue.
//
// Two field facts (measured live, 2026-11-09):
// 1. The AI endpoint accepts one call at a time — even 2 concurrent calls
//    return 429 "Too many requests" for one of them. Before the queue: a chimera
//    during a sweep, or a mission report during autopilot, crashed with a raw
//    error and no retry.
// 2. A call made immediately after a 429 succeeds — it is a concurrency limit,
//    not a quota.
//
// Therefore: all AI calls in the process go through a serial queue
// (concurrency 1) with gentle 429 retry. The call's timeout only starts when
// it leaves the queue — waiting in the queue (e.g. after an entire swarm)
// does not eat into the allotted time.
// Server-side only.
// ============================================================

import ZAI from "z-ai-web-dev-sdk";
import { markTimeoutError, type ErrorFactory } from "./ai-json";

let cached: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null;

export function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  if (!cached) {
    cached = ZAI.create().catch((e) => {
      // reset the cache on failure — the next call will try to create it again
      cached = null;
      throw e;
    });
  }
  return cached;
}

// ---------- global serial queue for AI calls ----------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let queueTail: Promise<unknown> = Promise.resolve();

function is429(e: unknown): boolean {
  return e instanceof Error && /\b429\b|too many requests/i.test(e.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- exact LLM-call instrumentation ----------

// Counts every real SDK call attempt that goes through llmComplete — one increment per invocation
// of the completions API, including 429 retries (and attempts that die on timeout/failure).
// Deliberate choice: attempts, not "logical calls". Quota pressure is consumed by attempts — a
// compile that needed 3 retries to land cost the endpoint 3 calls, and the old estimates
// (compile=2, execute=1/phase) hid that entirely. This is the honest number for quota pressure.
// Readers take deltas via llmCallSnapshot() — e.g. live-hunt measures each stage's exact usage
// against a snapshot taken at the stage's start (see runNextLocked).
let llmCallsTotal = 0;

/** Monotonic snapshot of the process-wide LLM call-attempt counter (never resets) */
export function llmCallSnapshot(): number {
  return llmCallsTotal;
}

/**
 * A single AI call through the global queue. In-process concurrency 1 + 429 retry
 * (1.5s then 3s) — raises the reliability of all engines even when two run
 * concurrently under different HTTP requests. Returns the response content
 * (string, possibly empty).
 */
export async function llmComplete(
  messages: LlmMessage[],
  opts?: { timeoutMs?: number; timeoutLabel?: string; timeoutError?: ErrorFactory }
): Promise<{ content: string }> {
  const run = async (): Promise<{ content: string }> => {
    const zai = await getZai();
    const timeoutMs = opts?.timeoutMs ?? 110_000;
    const label = opts?.timeoutLabel ?? "AI call";
    const Err: ErrorFactory = opts?.timeoutError ?? Error;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Counted per attempt, not per logical call — see llmCallsTotal above: a retry burns real quota
        llmCallsTotal++;
        // A separate timeout per attempt — the SDK does not support signal, so a local race.
        // Marking it as a timeout via markTimeoutError keeps isTimeoutError()
        // working in all upper layers (no pointless retry on a timeout).
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages,
            thinking: { type: "disabled" },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(markTimeoutError(new Err(`${label} timed out`))), timeoutMs);
          }),
        ]);
        return { content: (completion?.choices?.[0]?.message?.content as string | undefined) ?? "" };
      } catch (e) {
        lastErr = e;
        if (is429(e) && attempt < 2) {
          await sleep(attempt === 0 ? 1_500 : 3_000);
          continue;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("AI call failed");
  };

  // Chain onto the queue: the call starts only after all previous ones finish (success or failure alike)
  const job = queueTail.then(run, run);
  // prevent the queue from hanging on an unhandled rejection — the error flows to whoever awaits the job
  queueTail = job.catch(() => undefined);
  return job;
}
