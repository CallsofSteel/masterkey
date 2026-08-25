// Masterkey — POST /api/studio/assist (spec §8.2). The Bundle Studio chat bar's backend. Sign-in-gated
// (it spends the platform Anthropic key); rate-limited by proxy.ts. Takes the canvas's current nodes/edges
// + the user's message → runs the build-assist brain (src/lib/studio/assist.ts, registry-read-only) →
// returns the resulting graph as canvas nodes/edges, a chat reply, the change summary (ops), and any
// bundle metadata the brain set. The client applies nodes/edges to the Jotai atoms (optimistic) + saves.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { runAssist, isAssistConfigured } from "@/lib/studio/assist";
import { canvasToGraph, graphToCanvas } from "@/lib/studio/serialize";
import type { WorkflowEdge, WorkflowNode } from "@/lib/studio/workflow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NODES = 200; // canvas hard cap (§13.3)
const MAX_EDGES = 400;
const MAX_MESSAGE = 4000;

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (!isAssistConfigured()) {
    return NextResponse.json({ error: "build-assist is not configured on this deployment" }, { status: 503 });
  }

  let body: {
    message?: unknown;
    nodes?: unknown;
    edges?: unknown;
    focusNodeId?: unknown;
    name?: unknown;
    description?: unknown;
    reviewRunId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (!message) return NextResponse.json({ error: "say what you'd like to change" }, { status: 400 });

  const nodes = Array.isArray(body.nodes) ? (body.nodes as WorkflowNode[]) : [];
  const edges = Array.isArray(body.edges) ? (body.edges as WorkflowEdge[]) : [];
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
    return NextResponse.json({ error: "graph too large" }, { status: 400 });
  }

  const graph = canvasToGraph(nodes, edges);
  const focusNodeId = typeof body.focusNodeId === "string" ? body.focusNodeId : undefined;
  const name = typeof body.name === "string" ? body.name : undefined;
  const description = typeof body.description === "string" ? body.description : undefined;
  const reviewRunId = typeof body.reviewRunId === "string" ? body.reviewRunId : undefined;

  try {
    const result = await runAssist({ graph, message, focusNodeId, name, description, userId, reviewRunId });
    const canvas = graphToCanvas(result.graph);
    return NextResponse.json({
      reply: result.reply,
      ops: result.ops,
      nodes: canvas.nodes,
      edges: canvas.edges,
      metadata: result.metadata ?? null,
    });
  } catch (err) {
    console.error("[studio/assist] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "build-assist failed — try again" }, { status: 502 });
  }
}
