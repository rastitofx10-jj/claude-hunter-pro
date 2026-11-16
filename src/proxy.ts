import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin protection for mutation requests (POST/PUT/PATCH/DELETE) to the API.
 * (Ported 1:1 from src/middleware.ts — the "middleware" file convention Next 16 deprecated
 * in favor of proxy.ts.)
 *
 * Why: the app has no login system — the GitHub PAT is stored server-side and is used
 * automatically by all API routes. Without this protection layer, any malicious site the
 * tool owner visits could send cross-origin requests from their browser (CSRF) and run hunts/mining
 * on the PAT's API quota — and even delete the stored token.
 *
 * ROUND 15 — THE ENVIRONMENT-GAP FIX (the "Cross-Origin blocked" 403 the owner kept hitting):
 * The sandbox serves the app through a reverse-proxy chain:
 *     browser → platform edge (TLS) → Caddy :81 → Next.js :3000
 * The browser's Origin header names the EXTERNAL origin it sees, but the Host header that
 * reaches Next.js may be the INTERNAL one once the chain rewrites it. Comparing Origin
 * against Host alone rejected EVERY mutation from the real user's browser — while all
 * in-sandbox checks passed cleanly (curl sends no Origin at all; the headless test browser
 * connects as localhost, where Origin === Host). The block was also INVISIBLE: middleware
 * short-circuits produce no dev.log request line, so the log looked perfect while every
 * button in the owner's browser failed with "Cross-Origin blocked".
 *
 * The gate now accepts a browser request when ANY of these hold:
 *  1. Neither Origin nor Referer present — a non-browser client (curl / scripts /
 *     server-side schedulers) with no CSRF surface.
 *  2. `Sec-Fetch-Site: same-origin` (or `none`) — the browser's OWN verdict that the
 *     request target matches the page origin. Immune to any Host rewriting upstream;
 *     sent by every modern browser on fetch(), XHR, <img>, <script> and form submits.
 *     A hostile page cannot forge it (a non-browser forger can simply omit all headers
 *     and pass rule 1 instead — the gate only ever stopped naive browser requests).
 *  3. Origin (or Referer origin) matches the Host — direct same-origin access.
 *  4. Origin (or Referer origin) matches X-Forwarded-Host (+ X-Forwarded-Proto) — the
 *     standard proxy headers naming the original external host.
 * Every rejection now LOGS the full header context, so any residual environment gap is
 * diagnosable from dev.log instead of silently invisible.
 *
 * round 8: GET was exempted wholesale — but GET /api/analyze is a side-effectful,
 * quota-burning route (~25 authenticated GitHub calls + 2 DB writes per hit): a page of
 * hidden <img src="http://host/api/analyze?owner=a&repo=b"> tags drained the shared
 * 5,000/h quota. <img> never sends Origin, but browsers DO send Referer on subresource
 * loads by default — and Sec-Fetch-Site since 2020 — so the same four rules apply.
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

// ---- round 15: proxy-chain-aware same-origin gate ----

/** Proxies may append multiple values ("a, b") — judge only the first (closest) hop. */
function firstToken(v: string | null): string | null {
  if (!v) return null;
  const t = v.split(",")[0]?.trim();
  return t || null;
}

/**
 * Does `origin` (an already-normalized URL.origin string, no trailing slash,
 * default port stripped) name the same place as `host` (host[:port])?
 * Checks both schemes because the internal hop is http while the external one is https.
 */
function originMatchesHost(origin: string, host: string): boolean {
  try {
    return (
      origin === `http://${host}` ||
      origin === `https://${host}` ||
      origin === new URL(`http://${host}`).origin ||
      origin === new URL(`https://${host}`).origin
    );
  } catch {
    return false; // malformed host value
  }
}

/**
 * The whole round-15 verdict. Returns ok + a diagnostic `seen` snapshot of every
 * header the decision was based on (logged on reject, embedded in the 403 body —
 * so the exact environment chain is visible from dev.log AND from the user's toast).
 */
function browserRequestAllowed(req: NextRequest): { ok: boolean; seen: string } {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const secFetchSite = firstToken(req.headers.get("sec-fetch-site"));
  const host = req.headers.get("host");
  const fwdHost = firstToken(req.headers.get("x-forwarded-host"));
  const fwdProto = firstToken(req.headers.get("x-forwarded-proto")) ?? "http";

  const seen = `origin=${origin ?? "-"} referer=${referer ?? "-"} host=${host ?? "-"} xfh=${fwdHost ?? "-"} sfs=${secFetchSite ?? "-"}`;

  // (1) non-browser client — no Origin AND no Referer carries no CSRF surface
  if (!origin && !referer) return { ok: true, seen };

  // (2) the browser's own verdict — immune to proxy Host rewriting.
  //     `none` covers direct address-bar navigations (a user explicitly visiting the URL).
  if (secFetchSite === "same-origin" || secFetchSite === "none") return { ok: true, seen };

  // (3)+(4) judge the request's origin against every host name the chain reveals
  const candidateOrigin = origin ?? (() => {
    try {
      return referer ? new URL(referer).origin : null;
    } catch {
      return null;
    }
  })();

  if (candidateOrigin) {
    const matches = (h: string | null): boolean => {
      if (!h) return false;
      return originMatchesHost(candidateOrigin, h) || candidateOrigin === `${fwdProto}://${h}`;
    };
    if (matches(host) || matches(fwdHost)) return { ok: true, seen };
  }

  return { ok: false, seen };
}

export function proxy(req: NextRequest) {
  const path = new URL(req.url).pathname;

  // --- same-origin gate FIRST: cross-origin abuse is blocked before it can touch limiter state ---
  const needsBrowserGate = MUTATION_METHODS.has(req.method) || EXPENSIVE_GET_PATHS.has(path);
  if (needsBrowserGate) {
    const verdict = browserRequestAllowed(req);
    if (!verdict.ok) {
      // Round 15: middleware short-circuits never appear as request lines in dev.log —
      // a silent 403 was invisible while the user's every button failed. Log it loudly.
      console.log(`[proxy] BLOCKED ${req.method} ${path} — ${verdict.seen}`);
      return NextResponse.json(
        {
          error: `Cross-Origin blocked: this operation is allowed from the same origin only. If you are the operator, report this line: ${verdict.seen}`,
        },
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
