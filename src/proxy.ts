// Proxy (Next 16's renamed Middleware). Rate-limits /api/* with the Vercel KV (Upstash) store so the
// curated registry can't be bulk-scraped through the API. Reads the `masterkey_KV_REST_API_*` vars —
// the exact names Vercel's KV integration injects in prod — so local and prod use one naming, no
// aliasing. Degrades gracefully: if the vars are absent (local dev) it no-ops, and if the store is
// unreachable/errors at request time it fails OPEN (allows the request) rather than 500ing the API.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export const config = { matcher: "/api/:path*" };

const url = process.env.masterkey_KV_REST_API_URL;
const token = process.env.masterkey_KV_REST_API_TOKEN;

// 60 requests / minute / IP, sliding window. Generous for real browsing; throttles mass crawls.
const limiter =
  url && token
    ? new Ratelimit({
        // retry:false → a dead/unreachable store fails fast instead of backing off ~4s/request.
        redis: new Redis({ url, token, retry: false }),
        limiter: Ratelimit.slidingWindow(60, "60 s"),
        prefix: "masterkey-api",
        analytics: false,
        // If Redis is slow/unreachable, allow the request after 1s (fail-open) rather than block.
        timeout: 1000,
      })
    : null;

export async function proxy(request: NextRequest) {
  if (!limiter) return NextResponse.next(); // no creds → no limiting (dev / pre-setup)

  // Throttle two classes: (a) the curated-registry read surface (bulk-scrapeable), and (b) the studio
  // brain routes that spend the platform Anthropic key on each call (§13.2) — so an authed user can't
  // hammer expensive LLM generations. Everything else under /api/* is auth-gated app traffic (run-status
  // polling every ~1.5s, autosave on typing, account, assets, oauth) and stays EXEMPT so it isn't 429'd
  // mid-run/mid-edit. (Broader per-user limiting on those is future hardening — see WEB_SPEC W11.)
  const path = request.nextUrl.pathname;
  const isRegistry = path === "/api/catalog" || path.startsWith("/api/subcat");
  const isStudioBrain = path === "/api/studio/assist" || path === "/api/studio/generate";
  if (!isRegistry && !isStudioBrain) return NextResponse.next();

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";

  let result: Awaited<ReturnType<typeof limiter.limit>>;
  try {
    result = await limiter.limit(ip);
  } catch {
    return NextResponse.next(); // Upstash unreachable → fail open, don't break the API
  }
  const { success, limit, remaining, reset } = result;

  if (!success) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Slow down." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  const res = NextResponse.next();
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(remaining));
  return res;
}
