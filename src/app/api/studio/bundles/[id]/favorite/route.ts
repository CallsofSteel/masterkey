// POST /api/studio/bundles/[id]/favorite — toggle this bundle in the user's favorites (spec §5.2).
// Favorites are stored by SLUG on the user (§1.7), so curated and own bundles are both favoritable.
// Auth-gated; resolves the bundle (own-then-curated) to get its slug. Rate-limited by src/proxy.ts.
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getBundleById, toggleFavoriteBundleSlug } from "@/lib/studio/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const doc = await getBundleById(id, userId);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  const favorite = await toggleFavoriteBundleSlug(userId, doc.slug);
  return NextResponse.json({ slug: doc.slug, favorite });
}
