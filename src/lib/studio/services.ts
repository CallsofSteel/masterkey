// Masterkey — Bundle Studio service-picker data source (server-only). Never import from client code.
//
// Replaces Flow's AgentCash live-probe seam (spec §3, Appendix A). Flow probed endpoints live; we already
// carry each endpoint's VALIDATED schema/payment/usage in the registry, so a service node embeds that detail
// directly — NO live probing, NO payment (D6). This module is the single reuse point over the existing
// registry functions; the §3.2 API routes are thin wrappers over it.

import { findServiceById } from "@/lib/registry";
import { searchServices, getServiceDetail } from "@/lib/mcp/tools";
import { serviceToBundle, type BundleService } from "@/lib/bundle/format";
import { isApifyId, parseApifyId, enrichApifySchema, apifyService, searchApify } from "@/lib/apify";

/** Search the registry for the node palette — returns the same ranked summaries the catalog/MCP use. */
export function searchStudioServices(args: { query?: string; category?: string; limit?: number }) {
  return searchServices(args);
}

/** Apify dynamic search (~16k actors, not in the registry index) for the node palette, normalized to the
 *  same summary shape as registry results so the picker can merge them (spec §3.5). */
export function searchStudioApify(query: string, limit = 8): ReturnType<typeof searchServices>["results"] {
  const out = searchApify(query, limit);
  return out.results.map((r) => ({
    id: r.id, // "apify:<actorId>"
    name: r.title,
    provider: r.author || "Apify",
    category: "scraping",
    subcategory: "scraping",
    kind: "api" as const,
    price: { display: "~pennies / run", amount: null, unit: "per run" },
    description: (r.categories ?? []).join(", "),
    status: "active" as const,
  }));
}

/** The full, agent-facing get_service view (backends w/ providerId + firstParty + recommended, operations,
 *  usage, recommendedBackendProviderId). Drives the config panel's backend selector + schema editor. */
export type StudioServiceDetail = NonNullable<ReturnType<typeof getServiceDetail>>;

export interface StudioServiceResult {
  /** Rich detail for the config panel (backend selection, input schema, recommended/first-party backend). */
  detail: StudioServiceDetail;
  /** BundleService snapshot — stored on the service node (BundleNodeData.endpoint) for display/export, and
   *  re-resolved FRESH by compileRecipe at run time (never trusted for the actual run). */
  bundle: BundleService;
}

/**
 * Resolve a service for a node: the rich detail (for the config UI) + the BundleService snapshot (for the
 * node + SKILL.md export). Registry ids resolve synchronously; `apify:<actorId>` ids resolve dynamically
 * with an enriched live input schema (one Apify fetch — spec §3.5). Returns null if the id is unknown.
 */
export async function getStudioServiceDetail(id: string): Promise<StudioServiceResult | null> {
  // Apify: enrich the live actor schema ONCE, then derive both the detail view and the snapshot from it.
  if (isApifyId(id)) {
    const actorId = parseApifyId(id);
    if (!actorId) return null;
    const { schema, example } = await enrichApifySchema(actorId);
    const svc = apifyService(actorId, schema, example);
    if (!svc) return null;
    const b = svc.backends![0];
    const detail = {
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
      ...(svc.usage ? { usage: svc.usage } : {}),
      backends: [
        {
          provider: b.provider,
          providerId: b.providerId,
          firstParty: true, // Apify IS the provider
          recommended: true,
          url: b.url,
          method: b.method,
          modelParam: b.modelParam,
          price: b.price,
          authMode: b.authMode,
          payment: b.payment,
          inputSchema: b.inputSchema ?? null,
          outputSchema: null,
          ...(b.async ? { async: b.async } : {}),
          ...(b.team ? { team: b.team } : {}),
          status: b.status,
        },
      ],
      recommendedBackendProviderId: b.providerId,
      operations: [],
      note: "Apify actor — pay-per-run; exact $1 captured then unused refunded (~net pennies).",
    } as unknown as StudioServiceDetail;
    return { detail, bundle: serviceToBundle(svc) };
  }

  const svc = findServiceById(id);
  if (!svc) return null;
  const detail = getServiceDetail(id);
  if (!detail) return null;
  return { detail, bundle: serviceToBundle(svc) };
}
