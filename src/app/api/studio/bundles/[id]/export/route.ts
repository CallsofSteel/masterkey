// POST /api/studio/bundles/[id]/export?format=skill|json — export a bundle as a takeaway (spec §5.4/§11).
//   • skill (default) → a SKILL.md download for the user's own external agent (x402, its own wallet).
//   • json           → the graph + compiled recipe + x402 endpoint catalog.
// Auth-gated; resolves own-then-curated (curated are exportable, read-only). An optional body {nodes,edges,
// name,description} exports the CURRENT (possibly unsaved) canvas instead of the stored graph.
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getBundleById } from "@/lib/studio/store";
import { canvasToGraph } from "@/lib/studio/serialize";
import { graphToSkillMd, bundleToExportJson } from "@/lib/studio/export";
import type { BundleDoc } from "@/lib/studio/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/studio/workflow-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const doc = await getBundleById(id, userId);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Optional: export the current canvas (unsaved edits) rather than the stored graph.
  let body: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[]; name?: string; description?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* no body — export the stored bundle */
  }
  const target: BundleDoc = Array.isArray(body.nodes)
    ? {
        ...doc,
        name: body.name?.trim() || doc.name,
        description: body.description?.trim() ?? doc.description,
        graph: canvasToGraph(body.nodes, Array.isArray(body.edges) ? body.edges : []),
        steps: undefined, // a live canvas export is graph-only
      }
    : doc;

  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "skill";
  if (format === "json") {
    return NextResponse.json(bundleToExportJson(target));
  }
  return new NextResponse(graphToSkillMd(target), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${target.slug}.skill.md"`,
    },
  });
}
