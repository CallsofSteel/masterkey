// Masterkey — AgentCash index enumeration (top-of-funnel, read-only, deliberately SLOW).
//
//   npx tsx scripts/registry/discover-agentcash.mts                     # full taxonomy sweep
//   npx tsx scripts/registry/discover-agentcash.mts --queries=a,b,c     # targeted
//   npx tsx scripts/registry/discover-agentcash.mts --resume            # continue a stopped run
//
// ════════ WHY A SEPARATE PIPELINE ════════
// Bazaar hands you its whole index in 16 paginated calls. AgentCash does NOT: there is no bulk endpoint.
// Its consumer surface is `search` (SIWX-gated, ~100 results per query, 50/page), `discover <origin>` and
// `check <url>`. So the only way to enumerate what AgentCash knows is to ask it many questions and union
// the answers — which is a fundamentally different (and much slower) shape than the other sources.
//
// `discover <origin>` is NOT the way to enumerate them. It just re-reads that origin's own /openapi.json,
// which `discover-new.mjs --mode=depth` already does. The thing AgentCash uniquely knows is WHICH ORIGINS
// EXIST, and that only comes out of `search`.
//
// ════════ WHY IT IS WORTH THE SLOWNESS ════════
// AgentCash returns data no other source has:
//   • origin.protocols        — ["x402"] vs ["mpp"] vs both. We DROP mpp-only origins: our engine cannot
//                               pay them (curate.mjs auto-drops MPP backends), so indexing one is a bug.
//   • signals.resourceUsage   — transactionCount, uniqueWalletCount, volumeUsd, trustedUserUsageRatio.
//                               REAL traction. Which endpoints agents actually pay for is a far better
//                               prioritisation signal for our pay-test budget than any guess we can make.
//   • semanticDescription     — richer than the OpenAPI summary.
//   • authMode + price        — paid / siwx / unprotected, and the quoted cost.
//
// ════════ BEING A GOOD CITIZEN ════════
// This hits someone else's search index hundreds of times. It is throttled ON PURPOSE:
//   • ONE request at a time. No concurrency. Ever.
//   • A fixed polite delay between requests (--delay, default 1200ms).
//   • Exponential backoff that RESPECTS Retry-After on 429/5xx, and aborts the run after repeated 429s
//     rather than grinding away at a service that is asking us to stop.
//   • Checkpointed after every query, so --resume never re-asks something already answered.
// A slow complete sweep is strictly better than a fast one that gets us rate-limited or blocked.
//
// READ-ONLY: writes only to data/registry/discovery/. Never the registry. Same rule as discover-new.mjs.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signSiwxFromChallenge } from "../../src/lib/siwx.ts";
import { CATEGORIES } from "./queries.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const OUT_DIR = join(ROOT, "data/registry/discovery");
const CKPT = join(OUT_DIR, ".agentcash-checkpoint.json");
const SEARCH = "https://agentcash.dev/api/search";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DELAY_MS = Number(arg("delay", "1200"));
const PAGES = Number(arg("pages", "2"));         // totalResults caps ~100 at 50/page
const RESUME = argv.includes("--resume");
const MAX_429 = Number(arg("max-429", "5"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One SIWX-authenticated search call: unauthenticated probe → sign the 402 challenge → retry once. */
async function search(query: string, page: number): Promise<Record<string, unknown> | null> {
  // `broad:true` is NOT optional for our purpose. Measured 2026-07-29: it triples the result set
  // (query "api" 31 -> 100, "image generation" 32 -> 100) because it includes newer / unvetted tools.
  // Those are exactly the new providers we must not cut out, and 100 is the cap — hence 2 pages of 50.
  const body = JSON.stringify({ query, limit: 50, page, broad: true });
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  const first = await fetch(SEARCH, init);
  if (first.ok) return (await first.json()) as Record<string, unknown>;
  if (first.status === 429 || first.status >= 500) throw Object.assign(new Error(`http ${first.status}`), { status: first.status, retryAfter: first.headers.get("retry-after") });
  if (first.status !== 402) return null;

  const challenge = await first.json().catch(() => null);
  const auth = await signSiwxFromChallenge({ status: first.status, body: challenge, headers: first.headers });
  if (!auth) { console.error("  SIWX signing unavailable — is the Sponge wallet configured?"); return null; }
  const second = await fetch(SEARCH, { ...init, headers: { ...(init.headers as object), ...auth.headers } });
  if (second.status === 429 || second.status >= 500) throw Object.assign(new Error(`http ${second.status}`), { status: second.status, retryAfter: second.headers.get("retry-after") });
  if (!second.ok) return null;
  return (await second.json()) as Record<string, unknown>;
}

type Row = Record<string, unknown>;
const originsById = new Map<string, Row>();
const endpoints = new Map<string, Row>();
const askedQueries = new Set<string>();
let consecutive429 = 0;

function absorb(payload: Record<string, unknown> | null, query: string) {
  // Two shapes in the wild: the raw HTTP API returns {version, results:[…]} directly, while the MCP
  // wrapper nests it as {success, results:{version, results:[…]}}. Accept either.
  const direct = Array.isArray(payload?.results) ? (payload!.results as Row[]) : null;
  const nested = (payload?.results ?? payload) as Record<string, unknown> | undefined;
  const rows = direct ?? ((nested?.results ?? []) as Row[]);
  for (const r of rows) {
    const o = (r.origin ?? {}) as Record<string, unknown>;
    const originUrl = String(o.url ?? "").replace(/\/+$/, "");
    if (!originUrl) continue;
    if (!originsById.has(originUrl)) {
      originsById.set(originUrl, {
        origin: originUrl, title: o.title ?? null, description: o.description ?? null,
        protocols: o.protocols ?? [], x402OriginId: o.x402OriginId ?? null, mppOriginId: o.mppOriginId ?? null,
      });
    }
    const url = originUrl + String(r.path ?? "");
    if (!endpoints.has(url)) {
      endpoints.set(url, {
        url, origin: originUrl, method: r.method ?? null, name: r.summary ?? r.path ?? "",
        description: r.semanticDescription ?? r.summary ?? "", authMode: r.authMode ?? null,
        price: r.price ?? null, protocols: o.protocols ?? [],
        usage: (r.signals as Record<string, unknown> | undefined)?.resourceUsage ?? null,
        foundVia: query, sources: ["agentcash"],
      });
    }
  }
  return rows.length;
}

function saveCheckpoint() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CKPT, JSON.stringify({
    asked: [...askedQueries], origins: [...originsById.values()], endpoints: [...endpoints.values()],
  }));
}

(async () => {
  const explicit = arg("queries");
  const queries: string[] = explicit
    ? explicit.split(",").map((s) => s.trim()).filter(Boolean)
    : [...new Set((CATEGORIES as { subcategories: { queries: string[] }[] }[]).flatMap((c) => c.subcategories.flatMap((s) => s.queries)))];

  if (RESUME && existsSync(CKPT)) {
    const c = JSON.parse(readFileSync(CKPT, "utf8"));
    for (const q of c.asked ?? []) askedQueries.add(q);
    for (const o of c.origins ?? []) originsById.set(String(o.origin), o);
    for (const e of c.endpoints ?? []) endpoints.set(String(e.url), e);
    console.log(`resumed: ${askedQueries.size} queries already asked, ${originsById.size} origins, ${endpoints.size} endpoints`);
  }

  const todo = queries.filter((q) => !askedQueries.has(q));
  const estMin = Math.round((todo.length * PAGES * DELAY_MS) / 60000);
  console.log(`AgentCash enumeration — ${todo.length} queries x ${PAGES} pages, ${DELAY_MS}ms apart (~${estMin} min).`);
  console.log(`Sequential and throttled on purpose. Ctrl-C is safe; --resume continues.\n`);

  for (const [i, q] of todo.entries()) {
    for (let page = 1; page <= PAGES; page++) {
      let attempt = 0;
      for (;;) {
        try {
          const got = absorb(await search(q, page), q);
          consecutive429 = 0;
          if (page === 1) process.stdout.write(`\r  [${i + 1}/${todo.length}] ${q.slice(0, 34).padEnd(34)} origins=${originsById.size} endpoints=${endpoints.size}   `);
          if (got < 50) page = PAGES; // short page → no more results for this query
          break;
        } catch (e) {
          const err = e as { status?: number; retryAfter?: string };
          if (err.status === 429) {
            consecutive429++;
            if (consecutive429 >= MAX_429) {
              console.error(`\n\nSTOPPING: ${MAX_429} consecutive 429s. AgentCash is asking us to back off.`);
              console.error(`Progress is checkpointed — re-run with --resume later.`);
              saveCheckpoint(); process.exit(2);
            }
          }
          if (++attempt > 4) break;
          const wait = err.retryAfter ? Number(err.retryAfter) * 1000 : Math.min(30000, 2000 * 2 ** attempt);
          console.error(`\n  backing off ${Math.round(wait / 1000)}s (${err.status ?? "err"}) …`);
          await sleep(wait);
        }
      }
      await sleep(DELAY_MS);
    }
    askedQueries.add(q);
    if ((i + 1) % 10 === 0) saveCheckpoint();
  }
  saveCheckpoint();

  const list = [...endpoints.values()];

  // MPP-only origins are unpayable for us: curate.mjs drops MPP backends, so our engine could never
  // settle with them and indexing one would be a bug.
  const isMppOnly = (p: unknown) => Array.isArray(p) && p.includes("mpp") && !p.includes("x402");

  // Ephemeral preview deployments (`foo-a1b2c3d4-team.vercel.app`) are dropped outright — the URL is
  // dead within weeks, so pay-testing one is money burned on something that cannot be indexed.
  const PREVIEW = /-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app|^https?:\/\/[a-z0-9]+-[a-z0-9]{9}-/;

  // Platform-hosted (no own domain) is TIER 4 — kept, never dropped, but ranked last by the engine
  // (run.ts rankTargets / tools.ts rankBackendsForDisplay). It is a fallback, not a reject.
  const PLATFORM = /\.(vercel\.app|up\.railway\.app|workers\.dev|hf\.space|supabase\.co|onrender\.com|fly\.dev|netlify\.app|herokuapp\.com|trycloudflare\.com)(\/|$)/;

  const mppOnly = list.filter((e) => isMppOnly(e.protocols));
  const previews = list.filter((e) => !isMppOnly(e.protocols) && PREVIEW.test(String(e.url)));
  const payable = list
    .filter((e) => !isMppOnly(e.protocols) && !PREVIEW.test(String(e.url)))
    .map((e) => ({ ...e, tier: PLATFORM.test(String(e.url)) ? "T4" : "T3-or-better" }));
  const t4 = payable.filter((e) => e.tier === "T4").length;
  const dropped = mppOnly.length;

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
  const out = join(OUT_DIR, `agentcash-index-${stamp}.json`);
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    queriesAsked: askedQueries.size,
    totals: {
      origins: originsById.size,
      endpoints: list.length,
      mppOnlyDropped: dropped,          // unpayable protocol
      previewDeploysDropped: previews.length, // ephemeral URLs
      indexable: payable.length,        // what actually enters the funnel (was misleadingly named "usable")
      ofWhichTier4: t4,                 // platform-hosted: kept, but ranked last
    },
    origins: [...originsById.values()],
    endpoints: payable,
  }, null, 2));

  console.log(`\n\n════════ AGENTCASH ════════`);
  console.log(`  queries asked      : ${askedQueries.size}`);
  console.log(`  distinct origins   : ${originsById.size}`);
  console.log(`  endpoints          : ${list.length}`);
  console.log(`  mpp-only dropped   : ${dropped}   <- our engine cannot pay these`);
  console.log(`  previews dropped   : ${previews.length}   <- ephemeral URLs, dead within weeks`);
  console.log(`  INDEXABLE          : ${payable.length}`);
  console.log(`     └─ tier 4 (platform-hosted, ranked last as fallback): ${t4}`);
  console.log(`\n  report -> ${out.replace(ROOT + "/", "")}`);
  console.log(`  fold into the funnel:  node scripts/registry/discover-new.mjs --import=${out}`);
})();
