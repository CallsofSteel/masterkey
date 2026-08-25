// Masterkey — stable per-backend selector keys (pure; safe to import from client AND server).
//
// A `model`-kind service can have several backends that share a providerId — e.g. GPT Image 2 has TWO
// StableStudio backends (a `/generate` and a `/edit` endpoint). `backendProviderId` alone ("stablestudio")
// can't disambiguate them. These helpers derive a stable key per backend so the catalog UI can let a user
// pick the EXACT endpoint and run_service can resolve it back (see pickTarget in src/lib/mcp/run.ts).
//
// Key rules (must match on both sides — compute over the SAME ordered list, i.e. svc.backends):
//   • providerId unique among the service's backends  → key = providerId            (e.g. "xona", "blockrun")
//   • providerId duplicated, last URL segments differ → key = "<providerId>:<seg>"  (e.g. "stablestudio:edit")
//   • providerId duplicated AND segments collide      → key = "<providerId>:<index>" (positional fallback)

type Entry = { providerId: string; url: string };

function lastSeg(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? "";
  } catch {
    return "";
  }
}

/** The stable selector key for the backend at index `i` of `all` (registry order). */
export function backendKey(all: ReadonlyArray<Entry>, i: number): string {
  const entry = all[i];
  if (!entry) return "";
  const sameProvider = all.filter((e) => e.providerId === entry.providerId);
  if (sameProvider.length <= 1) return entry.providerId;
  const seg = lastSeg(entry.url);
  if (seg && sameProvider.filter((e) => lastSeg(e.url) === seg).length === 1) {
    return `${entry.providerId}:${seg}`;
  }
  return `${entry.providerId}:${i}`;
}

/** All selector keys, parallel to `all` by index. */
export function backendKeys(all: ReadonlyArray<Entry>): string[] {
  return all.map((_, i) => backendKey(all, i));
}

/** Resolve a caller-supplied key back to the matching backend index, or -1. Case-insensitive. */
export function indexForBackendKey(all: ReadonlyArray<Entry>, key: string): number {
  const want = key.toLowerCase();
  return backendKeys(all).findIndex((k) => k.toLowerCase() === want);
}
