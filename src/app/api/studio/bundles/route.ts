// /api/studio/bundles — Bundle CRUD list + create (spec §5.1). Auth-gated; ownership is implicit (a user
// only ever sees/creates their own + curated). Graph size is clamped (§13.3). Rate-limited by src/proxy.ts.
import { NextResponse } from "next/server";
import { getSessionUser, getSessionUserId } from "@/lib/session";
import { listBundles, saveBundle, mintUniqueSlug } from "@/lib/studio/store";
import { canvasToGraph, deriveSlug, bundleToApi } from "@/lib/studio/serialize";
import type { BundleDoc } from "@/lib/studio/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/studio/workflow-store";

export const dynamic = "force-dynamic";

const MAX_NODES = 200;
const MAX_EDGES = 400;

// GET — list own bundles + other users' PUBLIC (ready) bundles + curated (anon → curated only), with
// per-user favorite flags. `mine` marks the caller's own (drives the Mine tab + edit/delete on the client).
export async function GET() {
  const user = await getSessionUser();
  const userId = user?._id ?? null;
  const favorites = new Set(user?.favoriteBundleSlugs ?? []);
  const bundles = await listBundles(userId);
  return NextResponse.json({
    bundles: bundles.map((b) => bundleToApi(b, favorites.has(b.slug), b.ownerUserId != null && b.ownerUserId === userId)),
  });
}

// POST — create a new studio bundle from the canvas (nodes/edges → graph), minting a unique per-owner slug.
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: {
    name?: string;
    description?: string;
    trigger?: string;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
    inputs?: { name: string; prompt: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
    return NextResponse.json({ error: "graph too large" }, { status: 400 });
  }

  const slug = await mintUniqueSlug(userId, deriveSlug(name));
  const doc: BundleDoc = {
    _id: "",
    slug,
    name,
    description: (body.description ?? "").trim(),
    trigger: body.trigger,
    ownerUserId: userId,
    source: "studio",
    graph: canvasToGraph(nodes, edges),
    inputs: Array.isArray(body.inputs) ? body.inputs : [],
    status: "draft",
    createdISO: "",
    updatedISO: "",
  };
  const saved = await saveBundle(doc);
  return NextResponse.json(bundleToApi(saved, false), { status: 201 });
}
