// Masterkey — Bundle Studio canvas ⇆ graph serializer (isomorphic, pure). The §1.1 bridge: the canvas
// works in Flow's WorkflowNode model (xyflow needs `node.type` for its renderer map); the STORED/compiled
// model is §1.1 BundleGraph (`node.kind`). This module maps between them at the persistence boundary
// (spec §5/§7.5) so neither side has to know the other's shape. Plus slug derivation (§5.3).

import type { BundleGraph, BundleNode, BundleEdge, BundleNodeData, BundleDoc, NodeKind, DecisionOption } from "./types";
import type { WorkflowNode, WorkflowEdge, WorkflowNodeData } from "./workflow-store";
import { SLUG_RE } from "./types";

const KINDS: NodeKind[] = ["purpose", "service", "instruction", "decision", "input", "output", "loop"];
function toKind(t: string | undefined): NodeKind {
  return KINDS.includes(t as NodeKind) ? (t as NodeKind) : "instruction";
}

/** Map a canvas node's data (Flow working model) → §1.1 BundleNodeData (stored model). */
function dataToBundle(kind: NodeKind, d: WorkflowNodeData): BundleNodeData {
  const out: BundleNodeData = { label: d.label ?? "" };
  // service
  if (d.serviceId) out.serviceId = d.serviceId;
  if (d.backendProviderId) out.backendProviderId = d.backendProviderId;
  if (d.operation) out.operation = d.operation;
  if (d.inputMap) out.inputMap = d.inputMap;
  if (d.service) out.endpoint = d.service; // working `service` → §1.1 `endpoint` (the embedded snapshot)
  // a service node's author "notes" are its step instruction when none is set explicitly
  const instruction = d.instruction ?? (kind === "service" ? d.notes : undefined);
  if (instruction) out.instruction = instruction;
  // decision
  if (d.question) out.question = d.question;
  if (Array.isArray(d.options)) out.options = d.options.map((o): DecisionOption => ({ id: o.id, label: o.label }));
  // input
  if (d.prompt) out.prompt = d.prompt;
  if (d.required != null) out.required = d.required;
  if (d.saveAs) out.saveAs = d.saveAs;
  // output
  if (d.format) out.format = d.format;
  if (d.template) out.template = d.template;
  // loop (set by our loop node, §7.4)
  if (typeof d.overRef === "string") out.overRef = d.overRef;
  if (typeof d.until === "string") out.until = d.until;
  if (Array.isArray(d.bodyNodeIds)) out.bodyNodeIds = d.bodyNodeIds as string[];
  return out;
}

/** Map §1.1 BundleNodeData (stored) → a canvas node's data (Flow working model). */
function dataFromBundle(kind: NodeKind, d: BundleNodeData): WorkflowNodeData {
  const out: WorkflowNodeData = { label: d.label ?? "", type: kind };
  if (d.serviceId) out.serviceId = d.serviceId;
  if (d.backendProviderId) out.backendProviderId = d.backendProviderId;
  if (d.operation) out.operation = d.operation;
  if (d.inputMap) out.inputMap = d.inputMap;
  if (d.endpoint) out.service = d.endpoint;
  if (d.instruction) out.instruction = d.instruction;
  if (d.question) out.question = d.question;
  if (Array.isArray(d.options)) out.options = d.options.map((o) => ({ id: o.id, label: o.label }));
  if (d.prompt) out.prompt = d.prompt;
  if (d.required != null) out.required = d.required;
  if (d.saveAs) out.saveAs = d.saveAs;
  if (d.format) out.format = d.format;
  if (d.template) out.template = d.template;
  if (typeof d.overRef === "string") out.overRef = d.overRef;
  if (typeof d.until === "string") out.until = d.until;
  if (Array.isArray(d.bodyNodeIds)) out.bodyNodeIds = d.bodyNodeIds;
  return out;
}

/** Canvas (xyflow nodes/edges) → stored §1.1 BundleGraph. */
export function canvasToGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): BundleGraph {
  const outNodes: BundleNode[] = (nodes ?? []).map((n) => {
    const kind = toKind(n.data?.type ?? n.type);
    return { id: n.id, kind, position: n.position ?? { x: 0, y: 0 }, data: dataToBundle(kind, n.data ?? { label: "", type: kind }) };
  });
  const outEdges: BundleEdge[] = (edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
  }));
  return { nodes: outNodes, edges: outEdges };
}

/** Stored §1.1 BundleGraph → canvas (xyflow nodes/edges). */
export function graphToCanvas(graph: BundleGraph | undefined): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const nodes: WorkflowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position ?? { x: 0, y: 0 },
    data: dataFromBundle(n.kind, n.data),
  }));
  const edges: WorkflowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
  }));
  return { nodes, edges };
}

/** The client/API shape for a bundle: BundleDoc metadata + the canvas nodes/edges + a per-user favorite flag.
 *  Used by the Library (§4) and the canvas loader (api-client.workflow.*). */
export interface ApiBundle {
  id: string;
  slug: string;
  name: string;
  description: string;
  trigger?: string;
  source: BundleDoc["source"];
  status: BundleDoc["status"];
  ownerUserId: string | null;
  mine: boolean; // true = owned by the signed-in caller (drives Mine tab + edit/delete; shared others' are false)
  favorite: boolean;
  lastTestedISO?: string;
  inputs: { name: string; prompt: string }[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdISO: string;
  updatedISO: string;
}

/** Project a stored BundleDoc into the API/client shape (graph → canvas nodes/edges). `mine` = owned by the
 *  signed-in caller (false for curated + other users' shared bundles). Shared others' real ownerUserId is
 *  redacted to null so we don't expose user ids; the client filters on `mine` + `source`, not ownerUserId. */
export function bundleToApi(doc: BundleDoc, favorite: boolean, mine = true): ApiBundle {
  const { nodes, edges } = graphToCanvas(doc.graph);
  return {
    id: doc._id,
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    trigger: doc.trigger,
    source: doc.source,
    status: doc.status,
    ownerUserId: mine ? doc.ownerUserId : null,
    mine,
    favorite,
    lastTestedISO: doc.lastTestedISO,
    inputs: doc.inputs ?? [],
    nodes,
    edges,
    createdISO: doc.createdISO,
    updatedISO: doc.updatedISO,
  };
}

/** Derive a clean kebab slug from a name (spec §5.3). Falls back to "bundle". */
export function deriveSlug(name: string): string {
  const base = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return SLUG_RE.test(base) ? base : "bundle";
}
