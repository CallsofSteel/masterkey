// Dynamic Apify provider — resolves any of the ~16k x402 Apify actors on demand, WITHOUT storing them in
// the curated registry (no by-subcat/index bloat). Mirrors how the x402 Bazaar models Apify: the generic
// run endpoint parameterized by actorId, with each actor's input schema fetched live. Service id form:
// `apify:<username>~<name>` (e.g. `apify:apify~instagram-scraper`). findServiceById() resolves these, so
// run_service / estimate_cost / get_service work unchanged; discovery is via searchApify (apify_search tool).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Service, PaymentOption } from "@/data/types";

const DIR = join(process.cwd(), "data", "apify");

type ApifyActor = { actorId: string; author: string; title: string; categories: string[]; totalUsers: number; runUrl: string };
let _list: ApifyActor[] | null = null;
let _byId: Map<string, ApifyActor> | null = null;
let _accepts: PaymentOption[] | null = null;

function load() {
  if (_list) return;
  try { _list = JSON.parse(readFileSync(join(DIR, "actors.json"), "utf8")).actors ?? []; } catch { _list = []; }
  _byId = new Map(_list!.map((a) => [a.actorId, a]));
  try { _accepts = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8")).accepts ?? []; } catch { _accepts = []; }
}

const ACTOR_RE = /^[^~/\s]+~[^~/\s]+$/;
export function isApifyId(id: string): boolean { return typeof id === "string" && id.startsWith("apify:"); }
export function parseApifyId(id: string): string | null { if (!isApifyId(id)) return null; const a = id.slice("apify:".length); return ACTOR_RE.test(a) ? a : null; }

// Apify category → our nearest subcategory slug (for the synthesized Service; never written to disk).
const SUBCAT: Record<string, string> = {
  SOCIAL_MEDIA: "social-media-data", VIDEOS: "social-media-data", LEAD_GENERATION: "company-people-data",
  JOBS: "company-people-data", BUSINESS: "company-people-data", ECOMMERCE: "storefront-commerce-apis",
  TRAVEL: "scheduling-booking", SEO_TOOLS: "serp-seo-apis", NEWS: "news-media", REAL_ESTATE: "web-scraping",
};
const subcatFor = (cats: string[]) => { for (const c of cats || []) if (SUBCAT[c]) return SUBCAT[c]; return "web-scraping"; };

const REFUND_QUIRK = "x402 pay-per-use: the 402 advertises BOTH `exact` and `upto` schemes (max $1.00 USDC on Base). Pay exact $1.00; ~1 hour later the unused portion is auto-refunded on-chain, so net = the actor's actual run usage (typically pennies). The default ?maxTotalChargeUsd=0.50 caps the metered spend; raise/lower it as needed.";
const ACTORID_QUIRK = "actorId is the tilde slug username~name. POST /v2/actors/{actorId}/run-sync-get-dataset-items waits for the run and returns the dataset rows as a JSON array. Each actor defines its own input schema — get_service fetches it live (or GET /v2/acts/{actorId}).";

function runUrlFor(actorId: string): string {
  load();
  const base = _byId!.get(actorId)?.runUrl || `https://api.apify.com/v2/actors/${actorId}/run-sync-get-dataset-items`;
  return base.includes("?") ? base : base + "?maxTotalChargeUsd=0.50";
}

/** Synthesize a Service for an Apify actor (sync; no live schema). Returned by findServiceById → drives run. */
export function apifyService(actorId: string, schema?: Record<string, unknown> | null, inputExample?: Record<string, unknown>): Service | null {
  if (!ACTOR_RE.test(actorId)) return null;
  load();
  const rec = _byId!.get(actorId);
  const title = rec?.title || actorId;
  const cats = rec?.categories || [];
  const runUrl = runUrlFor(actorId);
  const price = { amount: null, currency: "USD" as const, unit: "per call", display: "Up to $1 (refunded to usage)", max: 1, dynamic: true, source: "live-402" as const };
  return {
    id: `apify:${actorId}`, kind: "api", name: `${title} (Apify)`, provider: "Apify", providerId: "apify",
    description: `Apify actor ${actorId}: ${title}. Pay-per-use scraper/automation via the Apify x402 gateway.`,
    category: "data-intelligence", subcategory: subcatFor(cats),
    tags: [...new Set([...cats.map((c) => c.toLowerCase()), "apify", "scraper", "x402"])],
    modality: { input: ["text"], output: ["json"] },
    pricing: { headline: "Up to $1 (refunded)", amount: null, currency: "USD", unit: "per call" },
    backends: [{
      provider: "Apify", providerId: "apify", url: runUrl, method: "POST", authMode: "x402", team: "Apify",
      price, payment: { protocols: ["x402"], accepts: (_accepts || []) as PaymentOption[] },
      inputSchema: schema ? { body: schema } : null, outputSchema: null, status: "active",
    }],
    operations: [],
    usage: {
      status: "verified", verifiedAt: "2026-06-19", resultPull: "sync", auth: "none",
      callShape: `POST ${runUrl} with a JSON body matching the actor input schema (x402)`,
      inputExample: inputExample || {},
      outputShape: "JSON array of dataset items (the scraped rows) — run-sync-get-dataset-items returns the data directly.",
      quirks: [REFUND_QUIRK, ACTORID_QUIRK],
      guide: `Apify actor "${title}" (${actorId}). POST the actor's input JSON to ${runUrl}; pay exact $1 (unused auto-refunded ~1h later). Returns dataset rows as a JSON array. Fetch the input schema via get_service or GET /v2/acts/${actorId}.`,
    },
    source: { serviceKey: actorId, discoveredVia: ["apify-store"], lastSyncedAt: "2026-06-19" },
    status: "active",
  };
}

// ---- live input-schema enrichment (cached) ----
const _schemaCache = new Map<string, { at: number; schema: Record<string, unknown> | null; example: Record<string, unknown> }>();
const TTL = 6 * 60 * 60 * 1000; // 6h
function buildExample(schema: Record<string, unknown> | null): Record<string, unknown> {
  const props = (schema?.properties as Record<string, { prefill?: unknown; default?: unknown }>) || null;
  if (!props) return {};
  const req = (Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  const ex: Record<string, unknown> = {};
  const take = (k: string) => { const p = props[k]; if (!p) return; const v = p.prefill !== undefined ? p.prefill : p.default; if (v !== undefined) ex[k] = v; };
  if (req.length) req.forEach(take); else Object.keys(props).filter((k) => props[k].prefill !== undefined).slice(0, 4).forEach(take);
  return ex;
}
export async function enrichApifySchema(actorId: string): Promise<{ schema: Record<string, unknown> | null; example: Record<string, unknown> }> {
  const c = _schemaCache.get(actorId); if (c && Date.now() - c.at < TTL) return { schema: c.schema, example: c.example };
  let schema: Record<string, unknown> | null = null;
  try {
    const act = (await (await fetch(`https://api.apify.com/v2/acts/${actorId}`, { headers: { accept: "application/json" } })).json())?.data;
    const buildId = act?.taggedBuilds?.latest?.buildId;
    if (buildId) {
      const build = (await (await fetch(`https://api.apify.com/v2/acts/${actorId}/builds/${buildId}`, { headers: { accept: "application/json" } })).json())?.data;
      if (build?.inputSchema) schema = typeof build.inputSchema === "string" ? JSON.parse(build.inputSchema) : build.inputSchema;
    }
  } catch { /* live fetch best-effort */ }
  const example = buildExample(schema);
  _schemaCache.set(actorId, { at: Date.now(), schema, example });
  return { schema, example };
}

/** Agent-facing detail for get_service (live schema). Same shape family as tools.getServiceDetail. */
export async function apifyServiceDetail(actorId: string) {
  const { schema, example } = await enrichApifySchema(actorId);
  const svc = apifyService(actorId, schema, example);
  if (!svc) return null;
  const b = svc.backends![0];
  return {
    id: svc.id, kind: svc.kind, name: svc.name, provider: svc.provider, description: svc.description,
    category: svc.category, subcategory: svc.subcategory, tags: svc.tags, modality: svc.modality, pricing: svc.pricing,
    backends: [{ provider: b.provider, providerId: b.providerId, url: b.url, method: b.method, price: b.price, authMode: b.authMode, payment: b.payment, inputSchema: b.inputSchema, outputSchema: null, team: b.team, status: b.status }],
    operations: [], usage: svc.usage, docs: { openapi: `https://api.apify.com/v2/acts/${actorId}` },
  };
}

/** Search the local 16k list (ranked by relevance + popularity). For the apify_search MCP tool. */
export function searchApify(query: string, limit = 20) {
  load();
  const q = (query || "").toLowerCase().trim();
  const toks = q.split(/\s+/).filter(Boolean);
  const scored = _list!.map((a) => {
    const hay = (a.title + " " + a.actorId + " " + (a.categories || []).join(" ")).toLowerCase();
    let s = 0;
    if (!q) s = 0;
    else { if (hay.includes(q)) s += 50; for (const t of toks) if (hay.includes(t)) s += 10; }
    s += Math.log10((a.totalUsers || 0) + 1) * 3; // popularity bias
    return { a, s, rel: q ? toks.some((t) => hay.includes(t)) || hay.includes(q) : true };
  });
  const pool = q ? scored.filter((x) => x.rel) : scored;
  pool.sort((x, y) => y.s - x.s);
  return {
    query: query || "", total: pool.length,
    results: pool.slice(0, Math.min(Math.max(limit, 1), 50)).map(({ a }) => ({
      id: `apify:${a.actorId}`, actorId: a.actorId, title: a.title, author: a.author,
      categories: a.categories, totalUsers: a.totalUsers,
    })),
    note: "Run any result with run_service(serviceId, {input:{…actor input…}}); call get_service(id) first for the live input schema. Pay-per-use: exact $1 captured, unused refunded ~1h later (net ~pennies).",
  };
}
