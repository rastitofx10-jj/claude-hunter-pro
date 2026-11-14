import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin protection for mutation requests (POST/PUT/PATCH/DELETE) to the API.
 * (Ported 1:1 from src/middleware.ts — the "middleware" file convention Next 16 deprecated
 * in favor of proxy.ts; the protection logic itself is unchanged.)
 *
 * Why: the app has no login system — the GitHub PAT is stored server-side and is used
 * automatically by all API routes. Without this protection layer, any malicious site the
 * tool owner visits could send cross-origin requests from their browser (CSRF) and run hunts/mining
 * on the PAT's API quota — and even delete the stored token.
 *
 * How: a browser always sends an Origin header on mutation requests. If Origin exists and does not
 * match the Host — immediate block. Requests without Origin (curl/scripts/server-side
 * tools) carry no CSRF risk and continue as usual, so external automation
 * and the existing workflow are not broken.
 *
 * round 8: GET was exempted wholesale — but GET /api/analyze is a side-effectful,
 * quota-burning route (~25 authenticated GitHub calls + 2 DB writes per hit): a page of
 * hidden <img src="http://host/api/analyze?owner=a&repo=b"> tags drained the shared
 * 5,000/h quota. <img> never sends Origin, but browsers DO send Referer on subresource
 * loads by default — so for these expensive GETs a cross-origin Referer is blocked too
 * (same-origin pages and header-less scripts keep working).
 *
 * Per-IP rate limiting (added with the middleware->proxy migration): the origin gate stops
 * hostile browsers, but a header-less client (script/curl, or a bug in our own tool) could still
 * hammer the API and burn the shared GitHub/LLM quota. Two fixed 60s windows per client IP:
 * 120 mutations/min (mutations + the expensive /api/analyze GET), 600 plain GETs/min.
 * /api/events (the SSE live stream) is exempt entirely — a long-lived connection must never
 * be counted per-message or blocked on reconnect (that route keeps its own connection cap).
 * Stale buckets are evicted opportunistically past 5,000 tracked IPs so memory stays bounded.
 * proxy.ts in Next 16 runs in the Node.js runtime, so a module-level Map is safe here.
 */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXPENSIVE_GET_PATHS = new Set(["/api/analyze"]);

// ---- per-IP fixed-window rate limiting ----
const RATE_WINDOW_MS = 60_000;
const MUTATION_RATE_LIMIT = 120; // mutations + expensive GETs per window
const GET_RATE_LIMIT = 600; // plain GETs per window
const MAX_TRACKED_IPS = 5000; // eviction trigger — keeps the maps bounded
// The SSE live stream — exempt from rate limiting entirely (long-lived connection)
const RATE_EXEMPT_PATHS = new Set(["/api/events"]);

type RateBucket = { count: number; windowStart: number };
// Two counters per IP: one for mutations/expensive GETs, one for plain GETs
const mutationBuckets = new Map<string, RateBucket>();
const getBuckets = new Map<string, RateBucket>();

function clientIp(req: NextRequest): string {
  // First hop in x-forwarded-for is the client; fall back through x-real-ip to "unknown"
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

function evictStaleBuckets(map: Map<string, RateBucket>, now: number): void {
  // Opportunistic sweep — only runs once the map exceeds MAX_TRACKED_IPS keys
  for (const [ip, bucket] of map) {
    if (now - bucket.windowStart >= RATE_WINDOW_MS) map.delete(ip);
  }
}

function consumeBucket(
  map: Map<string, RateBucket>,
  ip: string,
  limit: number,
  now: number
): { allowed: boolean; retryAfterSec: number } {
  if (map.size > MAX_TRACKED_IPS) evictStaleBuckets(map, now);
  let bucket = map.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    // new window (first hit, or the previous window expired)
    bucket = { count: 1, windowStart: now };
    map.set(ip, bucket);
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function sameOriginValue(headerValue: string | null, host: string | null): boolean | null {
  // null → header absent (cannot judge); true → matches; false → cross-origin
  if (!headerValue) return null;
  try {
    const origin = new URL(headerValue).origin;
    if (!host) return false;
    const hostOrigin = new URL(`http://${host}`).origin;
    return origin === hostOrigin || origin === `http://${host}` || origin === `https://${host}`;
  } catch {
    return false; // corrupted value — treated as hostile
  }
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host");
  const path = new URL(req.url).pathname;

  // --- same-origin gate FIRST: cross-origin abuse is blocked before it can touch limiter state ---
  if (MUTATION_METHODS.has(req.method)) {
    const originOk = sameOriginValue(req.headers.get("origin"), host);
    if (originOk === false) {
      // header present and cross-origin (null = non-browser client — no CSRF risk — passes)
      return NextResponse.json(
        { error: "Cross-Origin blocked: mutation requests are allowed from the same origin only" },
        { status: 403 }
      );
    }
  } else if (EXPENSIVE_GET_PATHS.has(path)) {
    // expensive side-effectful GETs: Origin check (fetch/XHR) + Referer check (<img>/<script> tags)
    const originOk = sameOriginValue(req.headers.get("origin"), host);
    const refererOk = sameOriginValue(req.headers.get("referer"), host);
    if (originOk === false || refererOk === false) {
      return NextResponse.json(
        { error: "Cross-Origin blocked: this operation is allowed from the same origin only" },
        { status: 403 }
      );
    }
  }

  // --- per-IP rate limiting (only for requests the origin gate already let through) ---
  if (!RATE_EXEMPT_PATHS.has(path)) {
    // mutations and the expensive /api/analyze GET share the tighter counter
    const isMutation = MUTATION_METHODS.has(req.method) || EXPENSIVE_GET_PATHS.has(path);
    const map = isMutation ? mutationBuckets : getBuckets;
    const limit = isMutation ? MUTATION_RATE_LIMIT : GET_RATE_LIMIT;
    const { allowed, retryAfterSec } = consumeBucket(map, clientIp(req), limit, Date.now());
    if (!allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded — slow down" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
