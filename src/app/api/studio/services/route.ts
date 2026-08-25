// GET /api/studio/services?q=&category=&limit= — registry search summaries for the Bundle Studio node
// palette (spec §3.2). Read-only reformatting of the SAME public registry data as /api/catalog, so it is
// public (the builder itself is sign-in-gated; the user-data/spend APIs in §5/§8/§10 are auth-gated).
// Rate-limited by src/proxy.ts (matches /api/:path*).
import { NextResponse } from "next/server";
import { searchStudioServices, searchStudioApify } from "@/lib/studio/services";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("q") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
  const base = searchStudioServices({ query, category, limit });
  // Optionally merge Apify's ~16k dynamic actors (not in the registry index) when the picker asks (§3.5).
  if (url.searchParams.get("apify") === "1" && query?.trim()) {
    const apify = searchStudioApify(query, Math.min(limit ?? 8, 8));
    return NextResponse.json({ ...base, results: [...base.results, ...apify], total: base.total + apify.length });
  }
  return NextResponse.json(base);
}
