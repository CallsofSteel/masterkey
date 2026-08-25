// GET /api/subcat/[slug] — full Service[] detail (incl. backends/payment) for one subcategory.
// The only path to the high-value technical detail; per-subcat only (no bulk dump). Rate-limited by src/proxy.ts.
import { NextResponse } from "next/server";
import { getSubcategory } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  const data = getSubcategory(slug);
  if (!data) {
    return NextResponse.json({ error: "subcategory not found" }, { status: 404 });
  }
  return NextResponse.json(data);
}
