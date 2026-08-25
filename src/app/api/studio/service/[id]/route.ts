// GET /api/studio/service/[id] — full service detail for a Bundle Studio service node (spec §3.2):
// the get_service view (backends w/ providerId + recommended/first-party, schema, payment, async, usage)
// plus the BundleService snapshot stored on the node + used for SKILL.md export. Resolves registry ids and
// `apify:<actorId>` ids (§3.5). Read-only public registry detail (same data as /api/subcat); rate-limited
// by src/proxy.ts.
import { NextResponse } from "next/server";
import { getStudioServiceDetail } from "@/lib/studio/services";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await getStudioServiceDetail(id);
  if (!result) {
    return NextResponse.json({ error: "service not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
