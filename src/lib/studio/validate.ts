// Masterkey — Bundle Studio canvas validation (isomorphic, pure). Surfaces authoring problems inline
// before save/run (spec §7.6): a service node with no service / no payable backend, a decision option with
// no target, a required input not connected, and accidental cycles (a cycle is only legitimate when a loop
// node declares it). Operates on the canvas working model; compile.ts produces the run-time equivalents.

import type { WorkflowNode, WorkflowEdge } from "./workflow-store";

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

/** Standard DFS cycle check over the directed edge set. */
function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=in-stack,2=done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (visit(n.id)) return true;
  return false;
}

export function validateCanvas(nodes: WorkflowNode[], edges: WorkflowEdge[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const outBySource = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = outBySource.get(e.source) ?? [];
    list.push(e);
    outBySource.set(e.source, list);
  }

  for (const n of nodes) {
    const d = n.data;
    const kind = d?.type;
    const label = d?.label || kind || "node";
    if (kind === "service") {
      if (!d.serviceId) issues.push({ nodeId: n.id, message: `"${label}" has no service selected.` });
      else if (d.service && d.service.endpoints.length === 0)
        issues.push({ nodeId: n.id, message: `"${label}" has no payable backend.` });
    } else if (kind === "decision") {
      // In the canvas model, decision routing is via edges from each option's source handle (id = opt.id).
      const handles = new Set((outBySource.get(n.id) ?? []).map((e) => e.sourceHandle).filter(Boolean));
      for (const opt of d.options ?? []) {
        if (!handles.has(opt.id))
          issues.push({ nodeId: n.id, message: `Decision "${label}" option "${opt.label}" has no target.` });
      }
    } else if (kind === "input" && d.required) {
      if (!(outBySource.get(n.id)?.length))
        issues.push({ nodeId: n.id, message: `Required input "${label}" isn't connected to any step.` });
    }
  }

  // A cycle is only legitimate when a loop node declares it. If there's no loop node and a cycle exists,
  // it's almost certainly accidental (the brain would loop indefinitely) — warn.
  const hasLoopNode = nodes.some((n) => n.data?.type === "loop");
  if (!hasLoopNode && hasCycle(nodes, edges)) {
    issues.push({ message: "The graph has a cycle but no loop node — add a loop node or remove the back-edge." });
  }

  return issues;
}
