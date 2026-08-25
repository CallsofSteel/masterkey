// GET /api/bundles — the "/"-command bundle summaries for the composer menu (spec §6.1). AUTH-AWARE:
// curated (always) + the signed-in user's own bundles, each tagged with a per-user `favorite` flag and an
// `owner` marker. Anonymous → curated only. Summary-only (no graph/detail). Rate-limited by src/proxy.ts.
// The /-menu must NEVER leak another user's bundles — listBundles filters by ownerUserId (§13.4).
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { listBundles } from "@/lib/studio/store";
import type { BundleSummary } from "@/lib/bundles";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  const favorites = new Set(user?.favoriteBundleSlugs ?? []);
  const all = await listBundles(user?._id ?? null);
  const bundles: BundleSummary[] = all.map((b) => ({
    slug: b.slug,
    name: b.name,
    description: b.description,
    trigger: b.trigger,
    favorite: favorites.has(b.slug),
    owner: b.ownerUserId != null,
  }));
  return NextResponse.json({ bundles });
}
