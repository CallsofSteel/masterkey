// Masterkey — MCP tool surface (server-only). Discovery tools (M6) registered onto the MCP server,
// plus the pure-logic functions behind them (exported so they can be unit/smoke-tested directly).
// `run_service` (M7) is registered separately. See MCP_SPEC.md M6 + Appendix R4/R6.
//
// Pricing copy rule (M6): the agent always SEES prices so it can choose, but NEVER pays — the price
// shown is what Masterkey pays the provider on the user's behalf, counted against their spend limit.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getIndex, findServiceById } from "@/lib/registry";
import { isApifyId, parseApifyId, apifyServiceDetail, searchApify } from "@/lib/apify";
import { getUser } from "@/lib/users";
import { getDb } from "@/lib/db";
import { resetPeriodIfDue, settledSince, settledForConnection } from "@/lib/spend/ledger";
import { COLLECTIONS, type ConnectionDoc, type LedgerDoc } from "@/lib/mcp/types";
import type { Backend, EntrySummary } from "@/data/types";
import { tierOf, tierLabel } from "@/data/team-tiers";

const PRICE_NOTE =
  "Price is what Masterkey pays the provider on your behalf; you never pay or hold a wallet. It counts against your spend limit.";

// ---- caller identity (from withMcpAuth → verifyMcpToken) -------------------------------------

export type Caller = { userId?: string; connectionId?: string; scopes: string[] };

export function callerFromExtra(extra: { authInfo?: AuthInfo }): Caller {
  const e = extra.authInfo?.extra as { userId?: string; connectionId?: string } | undefined;
  return { userId: e?.userId, connectionId: e?.connectionId, scopes: extra.authInfo?.scopes ?? [] };
}

// ---- list_categories ------------------------------------------------------------------------

export function listCategories() {
  return getIndex().categories;
}

// ---- search_services ------------------------------------------------------------------------

// Tiny alias expansion so developer-ish queries hit the right services (mirrors the catalog UI).
const ALIASES: Record<string, string[]> = {
  image: ["image", "img", "picture", "photo"],
  video: ["video", "clip", "movie"],
  audio: ["audio", "voice", "speech", "tts", "transcription"],
  llm: ["llm", "gpt", "language model", "chat", "completion"],
  search: ["search", "web search", "retrieval"],
  email: ["email", "mail", "smtp"],
  sms: ["sms", "text message", "twilio"],
};

function expand(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const a of ALIASES[t] ?? []) out.add(a);
  return [...out];
}

function summarize(e: EntrySummary) {
  return {
    id: e.id,
    name: e.name,
    provider: e.provider,
    category: e.category,
    subcategory: e.subcategory,
    kind: e.kind,
    price: e.price, // { display, amount, unit }
    description: e.description ?? "",
    status: e.status,
    ...(e.teams?.length ? { teams: e.teams } : {}), // operating teams across this service's endpoints
  };
}

function scoreEntry(e: EntrySummary, q: string, tokens: string[]): number {
  if (!q) return 0;
  const name = e.name.toLowerCase();
  const prov = e.provider.toLowerCase();
  const id = e.id.toLowerCase();
  const desc = (e.description ?? "").toLowerCase();
  const tags = e.tags.map((t) => t.toLowerCase());
  let s = 0;
  if (id === q || name === q) s += 100;
  if (name.startsWith(q)) s += 50;
  if (name.includes(q)) s += 30;
  if (prov.includes(q)) s += 20;
  if (tags.some((t) => t.includes(q))) s += 15;
  if (desc.includes(q)) s += 8;
  for (const t of tokens) {
    if (name.includes(t)) s += 6;
    if (prov.includes(t)) s += 4;
    if (tags.some((x) => x.includes(t))) s += 3;
    if (desc.includes(t)) s += 2;
  }
  return s;
}

// RUN_RELIABILITY_SPEC 5.3: quality bias added to the relevance score so working/known-price services
// surface first. Kept SEPARATE from the relevance filter (below) so it never pulls in irrelevant results.
function qualityBias(e: EntrySummary): number {
  let b = 0;
  if (e.status === "active") b += 12;
  else if (e.status === "needs-review") b -= 12; // unverified → push down
  if (e.price?.amount != null) b += 4; // a known price beats "Varies"/unpriced
  return b;
}
const priceOf = (e: EntrySummary): number => e.price?.amount ?? Infinity; // cheaper-first tiebreak; unpriced last

export function searchServices(args: { query?: string; category?: string; limit?: number }) {
  const entries = getIndex().entries.filter((e) => e.status !== "hidden");
  const cat = args.category?.toLowerCase().trim();
  const pool = cat
    ? entries.filter((e) => e.category.toLowerCase() === cat || e.subcategory.toLowerCase() === cat)
    : entries;

  const q = (args.query ?? "").toLowerCase().trim();
  const tokens = expand(q.split(/\s+/).filter(Boolean));
  // `rel` = pure relevance (drives the q-filter); `score` = relevance + quality bias (drives ranking).
  const scored = pool.map((e) => { const rel = scoreEntry(e, q, tokens); return { e, rel, score: rel + qualityBias(e) }; });
  const filtered = q ? scored.filter((s) => s.rel > 0) : scored;
  filtered.sort((a, b) => b.score - a.score || priceOf(a.e) - priceOf(b.e) || a.e.name.localeCompare(b.e.name));

  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  return {
    query: args.query ?? "",
    category: args.category ?? null,
    total: filtered.length,
    results: filtered.slice(0, limit).map((s) => summarize(s.e)),
    note: PRICE_NOTE,
  };
}

// ---- get_service ----------------------------------------------------------------------------

/** A backend is callable (and thus eligible to be the recommended one) only if it carries x402 payment
 *  requirements. Mirrors the run engine's isPayable() so the recommendation matches what run_service does. */
function backendIsPayable(b: Backend): boolean {
  return (b.payment?.protocols ?? []).includes("x402") && (b.payment?.accepts?.length ?? 0) > 0;
}
/** Order backends for display the SAME way the run engine ranks them when no provider is pinned:
 *  the service owner's own endpoint (firstParty) first, then cheapest. So the catalog/agent sees the
 *  official provider at the top — e.g. "use Exa" surfaces api.exa.ai, not whichever proxy is cheapest. */
const priceFloorOf = (b: Backend): number => b.price?.amount ?? b.price?.max ?? Infinity;
/**
 * Provider trust tier for display, from the single graded map in `src/data/team-tiers.ts`
 * (T1 owner's own host · T2 direct-relationship operator · T3 own domain · T4 proxy, no own domain).
 * Surfaced per backend so an agent can SEE why one is recommended instead of inferring it from price.
 */
export function backendTier(b: Pick<Backend, "firstParty" | "team" | "hosting">): "T1" | "T2" | "T3" | "T4" {
  return tierLabel(tierOf(b));
}

/**
 * Display order must MATCH what `run_service` will actually pick, or `recommended:true` is a lie.
 * Mirrors `rankTargets` in run.ts: full trust ladder (T1>T2>T3>T4) first, then cheapest. A lower-tier
 * provider being a fraction cheaper should never make it the headline choice.
 */
function rankBackendsForDisplay<T extends Backend>(backends: T[]): T[] {
  return [...backends].sort((a, b) => tierOf(a) - tierOf(b) || priceFloorOf(a) - priceFloorOf(b));
}

/** Cleaned, agent-facing view of a Service — strips internal `source`/`media`; drops internal ops. */
export function getServiceDetail(serviceId: string) {
  const svc = findServiceById(serviceId);
  if (!svc) return null;

  // Rank backends first-party-first (matching the run engine's default pick) and name the recommended
  // one explicitly, so the agent prefers the official provider and only pins a proxy on purpose.
  const ranked = rankBackendsForDisplay((svc.backends ?? []).filter((b) => b.status !== "hidden"));
  const recommended = ranked.find(backendIsPayable) ?? ranked[0];
  const recommendedBackendProviderId = recommended?.providerId ?? null;

  const backends = ranked.map((b) => ({
      provider: b.provider,
      providerId: b.providerId,
      firstParty: b.firstParty ?? false, // true ⟺ the service owner's own endpoint (preferred by default)
      tier: backendTier(b), // T1 own endpoint · T2 trusted team · T3 own domain · T4 no own domain (fallback)
      recommended: b.providerId === recommendedBackendProviderId, // the backend run_service uses if you don't pin one
      url: b.url,
      method: b.method,
      modelParam: b.modelParam,
      price: b.price,
      authMode: b.authMode,
      payment: b.payment,
      inputSchema: b.inputSchema ?? null,
      outputSchema: b.outputSchema ?? null,
      ...(b.async ? { async: b.async } : {}), // RUN_RELIABILITY_SPEC 5.1: surface async/poll semantics
      ...(b.team ? { team: b.team } : {}), // operating team behind this endpoint's host
      status: b.status,
    }));

  const operations = (svc.operations ?? [])
    .filter((o) => o.audience !== "internal")
    .map((o) => ({
      name: o.name,
      method: o.method,
      url: o.url,
      trivial: o.trivial ?? false,
      modelParam: o.modelParam,
      price: o.price,
      authMode: o.authMode,
      payment: o.payment,
      inputSchema: o.inputSchema,
      outputSchema: o.outputSchema,
      instructions: o.instructions,
      ...(o.usage ? { usage: o.usage } : {}), // RUN_RELIABILITY_SPEC 5.1: how to call this op correctly
      ...(o.async ? { async: o.async } : {}),
      ...(o.team ? { team: o.team } : {}), // operating team behind this op's host
    }));

  return {
    id: svc.id,
    kind: svc.kind,
    name: svc.name,
    aka: svc.aka ?? [],
    provider: svc.provider,
    description: svc.description,
    category: svc.category,
    subcategory: svc.subcategory,
    tags: svc.tags,
    modality: svc.modality ?? null,
    pricing: svc.pricing,
    docs: svc.docs ?? null,
    ...(svc.usage ? { usage: svc.usage } : {}), // RUN_RELIABILITY_SPEC 5.1: agent-facing "how to call this exactly"
    backends,
    // The backend run_service uses when you DON'T pass backendProviderId. It's the service owner's own
    // (first-party) endpoint when one exists — the trusted default. Only pin backendProviderId to override
    // (e.g. to force an aggregator route). recommended:true also marks it in the backends list above.
    // Backends are ordered by TRUST, not price: T1 (owner's own host) > T2 (operator we deal with
    // directly) > T3 (own domain, no relationship) > T4 (proxy with no own domain — fallback only).
    // `tier` on each backend shows where it sits, so the ordering is inspectable rather than implicit.
    recommendedBackendProviderId,
    operations,
    note: PRICE_NOTE,
  };
}

// ---- estimate_cost --------------------------------------------------------------------------

function priceView(p: {
  display?: string;
  headline?: string;
  amount: number | null;
  unit: string;
  min?: number | null;
  max?: number | null;
  dynamic?: boolean;
}) {
  return {
    display: p.display ?? p.headline ?? "",
    amount: p.amount,
    unit: p.unit,
    min: p.min ?? null,
    max: p.max ?? null,
    dynamic: p.dynamic ?? false,
  };
}

export function estimateServiceCost(args: { serviceId: string; backendProviderId?: string; operation?: string }) {
  const svc = findServiceById(args.serviceId);
  if (!svc) return null;

  // Prefer a backend price when backends exist (model kind AND api-kind services that carry provider
  // backends, e.g. Exa). Default pick mirrors the run engine: pinned provider → first-party → cheapest.
  if (svc.backends?.length) {
    const active = svc.backends.filter((b) => b.status !== "hidden");
    const chosen =
      (args.backendProviderId && active.find((b) => b.providerId === args.backendProviderId)) ||
      [...active].sort(
        (a, b) =>
          (b.firstParty ? 1 : 0) - (a.firstParty ? 1 : 0) ||
          (a.price.amount ?? a.price.max ?? Infinity) - (b.price.amount ?? b.price.max ?? Infinity),
      )[0];
    if (chosen) return { serviceId: svc.id, name: svc.name, provider: chosen.provider, backendProviderId: chosen.providerId, firstParty: chosen.firstParty ?? false, source: "backend", ...priceView(chosen.price), note: PRICE_NOTE };
  }
  if (svc.operations?.length) {
    const callable = svc.operations.filter((o) => o.audience !== "internal" && !o.trivial);
    const chosen = (args.operation && callable.find((o) => o.name === args.operation)) || callable[0];
    if (chosen) return { serviceId: svc.id, name: svc.name, operation: chosen.name, source: "operation", ...priceView(chosen.price), note: PRICE_NOTE };
  }
  return { serviceId: svc.id, name: svc.name, source: "service", ...priceView(svc.pricing), note: PRICE_NOTE };
}

// ---- get_limits -----------------------------------------------------------------------------

export async function getLimits(userId: string, connectionId: string) {
  const user = await getUser(userId);
  if (!user) return null;
  const db = await getDb();
  const conn = await db.collection<ConnectionDoc>(COLLECTIONS.connections).findOne({ _id: connectionId });
  return {
    monthlyLimitUsd: user.spend.monthlyLimitUsd,
    perCallMaxUsd: user.spend.perCallMaxUsd,
    advancedEnabled: user.spend.advancedEnabled,
    rules: user.spend.advancedEnabled ? user.spend.rules : [],
    connection: conn ? { name: conn.name, scopes: conn.scopes, status: conn.status } : null,
  };
}

// ---- get_usage ------------------------------------------------------------------------------

function startOfDayUTC(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function getUsage(userId: string, connectionId: string, period?: "month" | "day" | "session") {
  let user = await getUser(userId);
  if (!user) return null;
  user = await resetPeriodIfDue(user);

  const db = await getDb();
  const recentDocs = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  const monthlyLimitUsd = user.spend.monthlyLimitUsd;
  const spentThisPeriodUsd = user.billing.spentThisPeriodUsd;

  const out: Record<string, unknown> = {
    monthlyLimitUsd,
    spentThisPeriodUsd,
    remainingUsd: Math.max(0, monthlyLimitUsd - spentThisPeriodUsd),
    periodResetsISO: user.billing.periodResetsISO,
    recent: recentDocs.map((l) => ({
      serviceId: l.serviceId,
      serviceName: l.serviceName,
      provider: l.provider,
      operation: l.operation,
      costUsd: l.costUsd,
      status: l.status,
      network: l.network,
      createdAt: l.createdAt,
    })),
  };
  if (period === "day") out.todaySpentUsd = await settledSince(userId, startOfDayUTC());
  if (period === "session") out.sessionSpentUsd = await settledForConnection(connectionId);
  return out;
}

// ---- MCP registration -----------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Register all M6 discovery tools onto the MCP server. (run_service is added in M7.) */
export function registerDiscoveryTools(server: McpServer) {
  server.registerTool(
    "list_categories",
    {
      title: "List service categories",
      description:
        "Browse the Masterkey catalog's category/subcategory tree with service counts before searching. " +
        PRICE_NOTE,
      inputSchema: {},
    },
    async () => ok({ categories: listCategories() }),
  );

  server.registerTool(
    "search_services",
    {
      title: "Search services",
      description:
        "Find services/models by free-text query (optionally filtered to a category or subcategory slug). " +
        "Returns relevance-ranked summaries with id, name, provider, category, and price. Use get_service next to learn how to call one. " +
        PRICE_NOTE,
      inputSchema: {
        query: z.string().describe("Free-text search, e.g. 'image generation' or 'web search'.").optional(),
        category: z.string().describe("Optional category or subcategory slug to filter by.").optional(),
        limit: z.number().int().min(1).max(50).describe("Max results (default 20).").optional(),
      },
    },
    async (args) => ok(searchServices(args)),
  );

  server.registerTool(
    "get_service",
    {
      title: "Get service detail",
      description:
        "Get the full callable detail for one service by id: backends and/or operations (url, method, modelParam, " +
        "input schema, payment) plus modality and pricing. This is how you learn the input schema to call run_service. " +
        PRICE_NOTE,
      inputSchema: {
        serviceId: z.string().describe("The service id from search_services."),
      },
    },
    async ({ serviceId }) => {
      if (isApifyId(serviceId)) { const a = parseApifyId(serviceId); const d = a ? await apifyServiceDetail(a) : null; return d ? ok(d) : err(`invalid apify id: ${serviceId}`); }
      const svc = getServiceDetail(serviceId);
      return svc ? ok(svc) : err(`service not found: ${serviceId}`);
    },
  );

  server.registerTool(
    "apify_search",
    {
      title: "Search Apify actors",
      description:
        "Search Apify's ~16k x402 scraper/automation Actors (Instagram, Google Maps, LinkedIn, Amazon, Zillow, YouTube, lead-gen, etc.) — these are NOT in the main catalog (resolved dynamically). " +
        "Returns ranked actors with their service id `apify:<actorId>`. Then get_service(id) for the live input schema and run_service(id, {input:{…}}) to run it. " +
        "Pricing: pay-per-use — exact $1.00 USDC captured, unused auto-refunded ~1h later (net ≈ actual usage). " + PRICE_NOTE,
      inputSchema: {
        query: z.string().describe("What to scrape/automate, e.g. 'instagram profile', 'google maps reviews', 'amazon product'.").optional(),
        limit: z.number().int().min(1).max(50).describe("Max results (default 20).").optional(),
      },
    },
    async (args) => ok(searchApify(args.query ?? "", args.limit ?? 20)),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate cost",
      description:
        "Return the known/headline price for a service (optionally a specific backend or operation) WITHOUT calling it, " +
        "including whether the price is dynamic. Pure pre-flight for budgeting. " +
        PRICE_NOTE,
      inputSchema: {
        serviceId: z.string().describe("The service id."),
        backendProviderId: z.string().describe("Optional backend providerId (model-kind services).").optional(),
        operation: z.string().describe("Optional operation name (api-kind services).").optional(),
      },
    },
    async (args) => {
      const e = estimateServiceCost(args);
      return e ? ok(e) : err(`service not found: ${args.serviceId}`);
    },
  );

  server.registerTool(
    "get_limits",
    {
      title: "Get spend limits",
      description:
        "Return YOUR spend limits for this connection: monthly limit, per-call max, advanced rules, and the buckets " +
        "this connection is authorized to spend on (scopes). Self-check before calling run_service.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const c = callerFromExtra(extra as { authInfo?: AuthInfo });
      if (!c.userId || !c.connectionId) return err("not authenticated");
      const limits = await getLimits(c.userId, c.connectionId);
      return limits ? ok(limits) : err("user not found");
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get spend usage",
      description:
        "Return YOUR current spend usage: spent this period, monthly limit, remaining budget, period reset date, and " +
        "recent calls (service, cost, time). Pass period='day' or 'session' for those scoped totals.",
      inputSchema: {
        period: z.enum(["month", "day", "session"]).describe("Scope for an extra total (default month).").optional(),
      },
    },
    async ({ period }, extra) => {
      const c = callerFromExtra(extra as { authInfo?: AuthInfo });
      if (!c.userId || !c.connectionId) return err("not authenticated");
      const usage = await getUsage(c.userId, c.connectionId, period);
      return usage ? ok(usage) : err("user not found");
    },
  );
}
