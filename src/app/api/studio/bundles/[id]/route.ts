// /api/studio/bundles/[id] — get / update / delete one bundle (spec §5.1). Auth-gated + ownership-checked:
// reads of others' bundles 404 (not 403), mirroring runs (§13.1). Curated bundles are read-only.
import { NextResponse } from "next/server";
import { getSessionUser, getSessionUserId } from "@/lib/session";
import { getBundleById, getPublicBundleById, saveBundle, deleteBundle, mintUniqueSlug } from "@/lib/studio/store";
import { canvasToGraph, deriveSlug, bundleToApi } from "@/lib/studio/serialize";
import type { BundleDoc } from "@/lib/studio/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/studio/workflow-store";

export const dynamic = "force-dynamic";

const MAX_NODES = 200;
const MAX_EDGES = 400;

// GET — full bundle (graph → canvas nodes/edges) for the builder + a per-user favorite flag.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  const userId = user?._id ?? null;
  // Own or curated first; fall back to a PUBLIC (ready) bundle so a user can OPEN a shared skill read-only
  // (saving still requires ownership via PATCH). Private drafts of others never resolve.
  const doc = (await getBundleById(id, userId)) ?? (await getPublicBundleById(id));
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const favorite = (user?.favoriteBundleSlugs ?? []).includes(doc.slug);
  return NextResponse.json(bundleToApi(doc, favorite, doc.ownerUserId != null && doc.ownerUserId === userId));
}

// PATCH — update name/description/trigger/inputs/status and/or the graph (own bundles only).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const existing = await getBundleById(id, userId);
  if (!existing || existing.ownerUserId !== userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 }); // curated/others' → not editable
  }

  let body: {
    name?: string;
    description?: string;
    trigger?: string;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
    inputs?: { name: string; prompt: string }[];
    status?: BundleDoc["status"];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const next: BundleDoc = { ...existing };
  if (typeof body.name === "string" && body.name.trim()) {
    next.name = body.name.trim();
    // Rename → keep a unique per-owner slug (excluding this doc so it can keep its own).
    next.slug = await mintUniqueSlug(userId, deriveSlug(next.name), existing._id);
  }
  if (typeof body.description === "string") next.description = body.description.trim();
  if (typeof body.trigger === "string") next.trigger = body.trigger;
  if (Array.isArray(body.inputs)) next.inputs = body.inputs;
  if (body.status === "draft" || body.status === "ready") {
    next.status = body.status;
    // §10.2: a passing E2E test marks the bundle `ready` + stamps when it was last verified.
    if (body.status === "ready") next.lastTestedISO = new Date().toISOString();
  }
  if (Array.isArray(body.nodes) || Array.isArray(body.edges)) {
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    const edges = Array.isArray(body.edges) ? body.edges : [];
    if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
      return NextResponse.json({ error: "graph too large" }, { status: 400 });
    }
    next.graph = canvasToGraph(nodes, edges);
  }

  const saved = await saveBundle(next);
  return NextResponse.json(bundleToApi(saved, false));
}

// DELETE — remove an own bundle (curated cannot be deleted).
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const ok = await deleteBundle(id, userId);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
