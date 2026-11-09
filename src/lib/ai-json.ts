// ============================================================
// Shared AI-JSON helpers — the single source of truth for extracting,
// repairing, and normalizing LLM responses. All modules (genesis,
// mission-compiler, ai-intel) are required to use this — never duplicate
// this logic elsewhere.
// ============================================================

export class AiJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiJsonError";
  }
}

export type ErrorFactory = new (message: string) => Error;

const TIMEOUT_FLAG = "__ai_timeout__";

/** Whether the error was caused by a timeout — never retried (same result, wasted minutes) */
export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as Record<string, unknown>)[TIMEOUT_FLAG] === true;
}

/** Marks an error as a timeout — used by the queue in zai.ts so that upper-layer
 *  calls can detect timeouts (isTimeoutError) and avoid pointless retries */
export function markTimeoutError<T extends Error>(err: T): T {
  (err as unknown as Record<string, unknown>)[TIMEOUT_FLAG] = true;
  return err;
}

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  Err: ErrorFactory = AiJsonError
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      const t = setTimeout(() => {
        const err = new Err(`${label} timed out`) as Error & Record<string, unknown>;
        err[TIMEOUT_FLAG] = true;
        rej(err);
      }, ms);
      // prevent a timer leak — cleared once the main promise settles
      p.finally(() => clearTimeout(t)).catch(() => undefined);
    }),
  ]);
}

/**
 * Removes only the code fence wrapping the whole payload (```json ... ``` at
 * the start/end) — does not touch fences inside the JSON values themselves
 * (legitimate code blocks in fields), whose removal used to break valid
 * payloads (a critical bug, now fixed).
 */
export function stripFences(raw: string): string {
  let s = raw.trim();
  // opening fence only at the start of the payload: ```json / ```JSON / ```
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n?/, "");
  // closing fence only at the end of the payload
  s = s.replace(/\n?```\s*$/, "");
  return s.trim();
}

/**
 * For SKILL.md and other markdown documents: strips only the wrapping fence —
 * all internal code fences (```bash etc.) are kept exactly as the AI wrote them.
 */
export function stripOuterFence(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:markdown|md)?\s*\n/i, "");
  s = s.replace(/\n```\s*$/i, "");
  return s.trim();
}

export function repairTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Repairs inner quotes with key-position tracking:
 * a string opening after `{` `,` `[` is a key → `":` closes it.
 * A string opening after `:` is a value → a `"` before `:` counts as inner
 * content and gets escaped (the pathological case `"paste":"do "X": now"`),
 * while a closing before `,` `}` `]` is valid.
 */
export function escapeInnerQuotes(s: string): string {
  let out = "";
  let inStr = false;
  let backslashes = 0; // escape run: count consecutive \\ so a valid \" is not broken
  let keyPos = true; // does the next string open in key position?
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') {
        inStr = true;
        backslashes = 0;
        out += c;
        continue;
      }
      if (c === ':' || c === '}' || c === ']') {
        keyPos = false;
        out += c;
        continue;
      }
      if (c === ',' || c === '{' || c === '[') {
        keyPos = true;
        out += c;
        continue;
      }
      if (!/\s/.test(c)) keyPos = false; // scalar value (123/true) — the next string after it is not a key
      out += c;
    } else {
      if (c === '"') {
        const escaped = backslashes % 2 === 1;
        if (escaped) {
          out += c; // a valid \" — stays inside the string
          backslashes = 0;
          continue;
        }
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const nxt = s[j];
        if (
          nxt === undefined ||
          nxt === ',' ||
          nxt === '}' ||
          nxt === ']' ||
          (nxt === ':' && keyPos)
        ) {
          inStr = false;
          out += c;
          backslashes = 0;
        } else {
          out += '\\"'; // inner quote inside a value — escape it
          backslashes = 0;
        }
      } else if (c === '\\') {
        backslashes++;
        out += c;
      } else {
        if (c !== '\n' && c !== '\r') backslashes = 0;
        out += c;
      }
    }
  }
  return out;
}

/**
 * Balanced-brace scan from the first { — finds the true end of the object
 * (lastIndexOf fails when there is prose containing } after the JSON),
 * ignoring braces inside strings.
 */
function balancedObjectSlice(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(raw: string, Err: ErrorFactory = AiJsonError): Record<string, unknown> {
  const cleaned = stripFences(raw);
  // top-level array — only if `[` precedes `{` (some models return [...])
  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrEnd > firstArr) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(firstArr, arrEnd + 1));
        if (Array.isArray(parsed)) return { items: parsed };
      } catch {
        // not a valid array — continue down the object path
      }
    }
  }
  if (firstObj === -1) {
    throw new Err("The AI did not return JSON — try again");
  }
  const slice = balancedObjectSlice(cleaned, firstObj) ?? cleaned.slice(firstObj, cleaned.lastIndexOf("}") + 1);
  for (const cand of [
    slice,
    repairTrailingCommas(slice),
    escapeInnerQuotes(slice),
    repairTrailingCommas(escapeInnerQuotes(slice)),
  ]) {
    try {
      const parsed: unknown = JSON.parse(cand);
      if (parsed !== null && !Array.isArray(parsed) && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // next repair level
    }
  }
  throw new Err("The AI returned broken JSON — try again");
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

export function strArr(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Lenient JSON.parse for data stored in the DB — one corrupted field
 * must not bring down the entire request.
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Detects the Prisma "record not found" error (P2025) — to tell a 404 apart from a real 500 */
export function isPrismaNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "P2025"
  );
}

/**
 * Sanitizes code names coming from the AI before they enter the DB or
 * paths (`.claude/skills/<name>/SKILL.md`): only a-z 0-9 hyphen and underscore.
 * Prevents spaces, non-ASCII characters, path traversal (../) and empty names.
 */
export function sanitizeSlug(raw: unknown, fallback: string, maxLen = 60): string {
  const s = sanitizeSlugLoose(raw);
  return (s || fallback).slice(0, maxLen);
}

/** Version without a fallback — for cases that want to check emptiness themselves */
function sanitizeSlugLoose(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
