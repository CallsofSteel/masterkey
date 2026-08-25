// Server-only registry loader. Reads the curated registry from the non-public
// data/registry/ directory (never served as static files) and caches it in memory.
// Only imported by server code (route handlers + server components) — never the client.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryIndex, Service } from "@/data/types";
import { isApifyId, parseApifyId, apifyService } from "@/lib/apify";

const DIR = join(process.cwd(), "data", "registry");

// In production the registry files are static for the life of the process, so we cache in memory.
// In development we re-read on every call — otherwise a registry rebuild (e.g. pruning entries)
// won't show up until the dev server restarts, and the cached index can drift out of sync with
// the freshly-read per-subcategory detail (summary shows an entry whose detail is already gone).
const CACHE = process.env.NODE_ENV === "production";

let _index: RegistryIndex | null = null;
const _shards = new Map<string, Service[] | null>();

// Hidden services/backends are kept in the stored registry files as the durable record of QA
// decisions, but must never be served. Every consumer goes through getIndex()/getSubcategory(),
// so we filter here — matching the MCP layer (src/lib/mcp/tools.ts) so web + agent see the same
// clean view. status:"hidden" = dropped (dead/broken); "active"/"needs-review" stay visible.
function visibleIndex(raw: RegistryIndex): RegistryIndex {
  const entries = raw.entries.filter((e) => e.status !== "hidden");
  // recompute category + subcategory counts from the visible entries (keyed by slug)
  const catCount = new Map<string, number>();
  const subCount = new Map<string, number>();
  for (const e of entries) {
    catCount.set(e.category, (catCount.get(e.category) ?? 0) + 1);
    subCount.set(e.subcategory, (subCount.get(e.subcategory) ?? 0) + 1);
  }
  const categories = raw.categories
    .map((c) => ({
      ...c,
      count: catCount.get(c.slug) ?? 0,
      subcategories: c.subcategories
        .map((s) => ({ ...s, count: subCount.get(s.slug) ?? 0 }))
        .filter((s) => s.count > 0),
    }))
    .filter((c) => c.count > 0);
  return { ...raw, categories, entries };
}

function visibleServices(raw: Service[]): Service[] {
  return raw
    .filter((s) => s.status !== "hidden")
    .map((s) => {
      // Hidden OPERATIONS are filtered for the same reason as hidden backends: they stay in the stored
      // file as the durable "we indexed and tested this, it's dead" record, but are never served.
      const operations = Array.isArray(s.operations) ? s.operations.filter((o) => o.status !== "hidden") : s.operations;
      if (!Array.isArray(s.backends) || s.backends.length === 0) return { ...s, operations };
      const backends = s.backends.filter((b) => b.status !== "hidden");
      return { ...s, backends, operations };
    })
    // drop a service whose backends AND operations were all hidden (nothing callable left)
    .filter((s) => !Array.isArray(s.backends) || s.backends.length > 0 || (s.operations?.length ?? 0) > 0);
}

/** Manifest: category tree + summary entries + syncedAt. Summary-only (no backends/schemas). Hidden filtered. */
export function getIndex(): RegistryIndex {
  if (!CACHE || !_index) {
    const raw = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as RegistryIndex;
    _index = visibleIndex(raw);
  }
  return _index;
}

/** Full Service[] detail (incl. backends/payment) for one subcategory, or null if unknown. Hidden filtered. */
export function getSubcategory(slug: string): Service[] | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null; // guard against path traversal
  if (CACHE && _shards.has(slug)) return _shards.get(slug)!;
  let data: Service[] | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(DIR, "by-subcat", `${slug}.json`), "utf8")) as Service[];
    data = visibleServices(raw);
  } catch {
    data = null;
  }
  if (CACHE) _shards.set(slug, data);
  return data;
}

// id → subcategory slug, built once from the index so a service can be located in O(1) without
// scanning every shard (MCP_SPEC.md M6; verified at build: unique ids, no missing shards).
let _idToSubcat: Map<string, string> | null = null;
function idToSubcat(): Map<string, string> {
  if (!CACHE || !_idToSubcat) {
    const m = new Map<string, string>();
    for (const e of getIndex().entries) m.set(e.id, e.subcategory);
    _idToSubcat = m;
  }
  return _idToSubcat;
}

/** Resolve a Service by its stable id (locates the subcategory shard via the index).
 *  `apify:<actorId>` ids resolve DYNAMICALLY (Apify's ~16k actors are not stored in the registry —
 *  see src/lib/apify.ts) so run/get_service/estimate work without bloating by-subcat/index. */
export function findServiceById(id: string): Service | null {
  if (isApifyId(id)) { const a = parseApifyId(id); return a ? apifyService(a) : null; }
  const slug = idToSubcat().get(id);
  if (!slug) return null;
  const shard = getSubcategory(slug);
  return shard?.find((s) => s.id === id) ?? null;
}
