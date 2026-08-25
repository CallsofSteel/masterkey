// Masterkey — Bundle Studio recipe compiler (server-only; reads the registry).
//
// Turns a saved Bundle (graph OR legacy linear steps[]) into a CompiledRecipe — the single, ordered,
// service-pinned representation the brain runs (via seed-prompt §6.3) AND the SKILL.md export renders
// (§11). Both consume THIS, so they never drift (spec §1.4).
//
// Ported from Flow's lib/exports/skill-bundle.ts (topological sort + per-node rendering), adapted to:
//   • our registry — each service node's endpoint detail is re-resolved FRESH via findServiceById at
//     compile time (the node's stored `endpoint` snapshot is for display only; we never trust it for the
//     run), and
//   • branch/loop rendering for the Messages-API brain instead of a Claude-Code SKILL.md.
//
// Server-only: imports findServiceById (registry fs reads). Compile at run-creation (POST /api/runs, §6.2),
// not inside the Trigger task.

import { findServiceById } from "@/lib/registry";
import { serviceToBundle, type BundleService } from "@/lib/bundle/format";
import type { BundleDoc, BundleGraph, BundleNode, NodeKind } from "./types";

/** One ordered step the brain performs. Service steps carry a pinned run_service call + fresh endpoint detail. */
export interface CompiledStep {
  index: number; // 1-based position in the linear walk
  nodeId: string; // "" for legacy linear steps (no graph)
  kind: NodeKind;
  label: string;
  instruction: string; // plain-English step for the brain (fallback rendering; structured fields are authoritative)
  // service step:
  serviceId?: string;
  backendProviderId?: string; // pinned backend; omitted → run defaults to recommended/first-party
  operation?: string;
  inputMap?: Record<string, string>;
  endpoint?: BundleService; // FRESH registry detail (price/schema/usage); undefined if the service vanished
  // input step:
  inputName?: string;
}

/** A decision node rendered as explicit "if <option> → go to step N" routing. */
export interface CompiledBranch {
  fromStepIndex: number; // the decision step's index
  question: string;
  options: { label: string; goToStepIndex: number | null; goToNodeId?: string }[];
}

/** A loop node rendered as "repeat steps X–Y for each <item> until <condition>". */
export interface CompiledLoop {
  fromStepIndex: number;
  overRef?: string;
  until?: string;
  bodyStepIndexes: number[];
}

export interface CompiledRecipe {
  slug: string;
  name: string;
  description: string;
  trigger?: string;
  steps: CompiledStep[];
  branches: CompiledBranch[];
  loops: CompiledLoop[];
  inputs: { name: string; prompt: string }[];
  warnings: string[]; // soft problems surfaced to the author/run (no payable backend, dangling branch, …)
}

// ── Graph walk ────────────────────────────────────────────────────────────────────────────────────
// Kahn's topological sort, cycle-aware. Declared loops create back-edges; any node not reached by the
// queue (i.e. inside a cycle or disconnected) is appended in its original order so nothing is dropped.
// Mirrors Flow's topologicalSort (skill-bundle.ts) but typed to our BundleNode/BundleEdge.
function topoSort(graph: BundleGraph): BundleNode[] {
  const { nodes, edges } = graph;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue; // ignore dangling edges
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const sorted: BundleNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodeMap.get(id);
    if (node) sorted.push(node);
    for (const next of adj.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg <= 0 && !seen.has(next)) queue.push(next);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) sorted.push(n); // cycle/disconnected remainder, original order
  return sorted;
}

function kebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Resolve a service node's fresh registry detail. Returns the BundleService + a warning if missing/unpayable. */
function resolveServiceNode(serviceId: string | undefined): { endpoint?: BundleService; warning?: string } {
  if (!serviceId) return { warning: "A service node has no serviceId selected." };
  const svc = findServiceById(serviceId);
  if (!svc) return { warning: `Service "${serviceId}" is no longer in the registry.` };
  const endpoint = serviceToBundle(svc);
  if (!endpoint.endpoints.length) {
    return { endpoint, warning: `Service "${serviceId}" has no payable backend.` };
  }
  return { endpoint };
}

// ── Compile ─────────────────────────────────────────────────────────────────────────────────────--
/**
 * Compile a bundle into the ordered recipe the brain runs. Accepts EITHER a graph (studio/quick bundles)
 * or a legacy linear steps[] (curated files) — the latter compiles straight through unchanged (spec §1.3,
 * back-compat §14.2). For graphs we topo-sort, emit one CompiledStep per non-purpose node, then derive
 * branch/loop routing from decision/loop nodes (resolved to step indices).
 */
export function compileRecipe(bundle: BundleDoc): CompiledRecipe {
  const warnings: string[] = [];
  const base = {
    slug: bundle.slug,
    name: bundle.name,
    description: bundle.description,
    trigger: bundle.trigger,
  };

  // ── Legacy linear path — curated data/bundles/*.json (no graph). Compile straight through. ──
  if (!bundle.graph || !bundle.graph.nodes.length) {
    const steps: CompiledStep[] = (bundle.steps ?? []).map((s, i) => {
      const kind: NodeKind = s.serviceId ? "service" : "instruction";
      const r = s.serviceId ? resolveServiceNode(s.serviceId) : {};
      if (r.warning) warnings.push(r.warning);
      return {
        index: i + 1,
        nodeId: "",
        kind,
        label: s.label,
        instruction: s.instruction || s.label, // human guidance; run_service mechanics live in structured fields
        ...(s.serviceId ? { serviceId: s.serviceId } : {}),
        ...(r.endpoint ? { endpoint: r.endpoint } : {}),
      };
    });
    return { ...base, steps, branches: [], loops: [], inputs: bundle.inputs ?? [], warnings };
  }

  // ── Graph path — topo-sort, then emit steps + branches + loops. ──
  const ordered = topoSort(bundle.graph);
  const steps: CompiledStep[] = [];
  const nodeIdToStepIndex = new Map<string, number>();
  const inputs: { name: string; prompt: string }[] = [];

  for (const node of ordered) {
    if (node.kind === "purpose") continue; // purpose → bundle metadata, not a step
    const idx = steps.length + 1;
    nodeIdToStepIndex.set(node.id, idx);
    const d = node.data;
    const label = d.label || `Step ${idx}`;

    if (node.kind === "service") {
      const r = resolveServiceNode(d.serviceId);
      if (r.warning) warnings.push(r.warning);
      steps.push({
        index: idx,
        nodeId: node.id,
        kind: "service",
        label,
        instruction: d.instruction || label, // human guidance; run_service mechanics live in structured fields
        ...(d.serviceId ? { serviceId: d.serviceId } : {}),
        ...(d.backendProviderId ? { backendProviderId: d.backendProviderId } : {}),
        ...(d.operation ? { operation: d.operation } : {}),
        ...(d.inputMap ? { inputMap: d.inputMap } : {}),
        ...(r.endpoint ? { endpoint: r.endpoint } : {}),
      });
    } else if (node.kind === "input") {
      const name = d.saveAs || kebab(label) || `input_${idx}`;
      const prompt = d.prompt || label;
      inputs.push({ name, prompt });
      steps.push({
        index: idx,
        nodeId: node.id,
        kind: "input",
        label,
        instruction: `${prompt}${d.required ? " (required)" : ""}`, // bare human prompt; renderer phrases "Ask the operator…"
        inputName: name,
      });
    } else {
      // instruction / decision / output / loop — a reasoning/IO step (no service call here).
      const instruction =
        node.kind === "decision"
          ? d.question || label
          : node.kind === "output"
            ? `${d.instruction || d.template || label}${d.format ? ` (as ${d.format})` : ""}`
            : d.instruction || label;
      steps.push({ index: idx, nodeId: node.id, kind: node.kind, label, instruction });
    }
  }

  // Branches: each decision node → its options, resolved to step indices (via goToNodeId or a matching edge).
  const branches: CompiledBranch[] = [];
  for (const node of ordered) {
    if (node.kind !== "decision") continue;
    const fromStepIndex = nodeIdToStepIndex.get(node.id);
    if (fromStepIndex == null) continue;
    const opts = node.data.options ?? [];
    const options = opts.map((o) => {
      let targetNodeId = o.goToNodeId;
      if (!targetNodeId) {
        const edge = bundle.graph!.edges.find((e) => e.source === node.id && e.sourceHandle === o.id);
        targetNodeId = edge?.target;
      }
      const goToStepIndex = targetNodeId ? nodeIdToStepIndex.get(targetNodeId) ?? null : null;
      if (!targetNodeId || goToStepIndex == null) {
        warnings.push(`Decision "${node.data.label || node.id}" option "${o.label}" has no valid target.`);
      }
      return { label: o.label, goToStepIndex, goToNodeId: targetNodeId };
    });
    branches.push({ fromStepIndex, question: node.data.question || node.data.label || "", options });
  }

  // Loops: each loop node → its body nodes resolved to step indices.
  const loops: CompiledLoop[] = [];
  for (const node of ordered) {
    if (node.kind !== "loop") continue;
    const fromStepIndex = nodeIdToStepIndex.get(node.id);
    if (fromStepIndex == null) continue;
    const bodyStepIndexes = (node.data.bodyNodeIds ?? [])
      .map((id) => nodeIdToStepIndex.get(id))
      .filter((i): i is number => i != null);
    loops.push({ fromStepIndex, overRef: node.data.overRef, until: node.data.until, bodyStepIndexes });
  }

  return { ...base, steps, branches, loops, inputs: inputs.length ? inputs : bundle.inputs ?? [], warnings };
}

// ── Canonical recipe rendering (spec §1.4) ──────────────────────────────────────────────────────--
// The SINGLE textual rendering of a CompiledRecipe, so the brain runner (seed-prompt §6.3) and the
// SKILL.md export (§11) never drift — both render from THIS, never from the raw graph. Mirrors the
// existing "/slug" bundle block in seed-prompt.ts (ordered, service-pinned chain, output→input),
// extended with explicit branch/loop instructions (Flow's proven rendering — see §1.5 on determinism).

function serviceCallHint(step: CompiledStep): string {
  if (!step.serviceId) return "";
  const bits = [`serviceId "${step.serviceId}"`];
  if (step.backendProviderId) bits.push(`backendProviderId "${step.backendProviderId}"`);
  if (step.operation) bits.push(`operation "${step.operation}"`);
  let hint = ` → call run_service with ${bits.join(", ")}`;
  if (step.inputMap && Object.keys(step.inputMap).length) {
    hint += `; map inputs ${Object.entries(step.inputMap).map(([k, v]) => `${k} ← ${v}`).join(", ")}`;
  }
  return hint + ".";
}

// Inline the pinned service's TESTED call guidance (guide + call shape + concrete input example, else the
// raw input schema) straight into the recipe, so the brain calls the endpoint CORRECTLY before it ever
// pays. A paid 200 with the wrong input shape (e.g. FullEnrich's `{value:...}` wrapping, Apollo's exact
// seniority vocab) returns empty AND still costs money — this usage block is the registry's QA moat, and
// renderRecipeForBrain used to omit it, forcing the brain to guess the shape or fetch it via get_service.
function serviceUsageLines(step: CompiledStep): string[] {
  const ep = step.endpoint;
  if (!ep) return [];
  const out: string[] = [];
  const u = ep.usage;
  if (u?.guide) out.push(`   • How to call it: ${u.guide}`);
  if (u?.callShape) out.push(`   • Call shape: ${u.callShape}`);
  if (u?.inputExample && Object.keys(u.inputExample).length) {
    out.push(`   • Example input (match this shape exactly): ${JSON.stringify(u.inputExample)}`);
  } else {
    const schema = ep.endpoints.find((e) => e.inputSchema && Object.keys(e.inputSchema).length)?.inputSchema;
    if (schema) out.push(`   • Input schema: ${JSON.stringify(schema)}`);
  }
  if (u?.quirks?.length) for (const q of u.quirks) out.push(`   • Note: ${q}`);
  return out;
}

function stepLine(step: CompiledStep): string {
  const n = step.index;
  const detail = step.instruction && step.instruction !== step.label ? ` — ${step.instruction}` : "";
  switch (step.kind) {
    case "service":
      return `${n}. ${step.label}${detail}${serviceCallHint(step)}`;
    case "input":
      return `${n}. Ask the operator for "${step.inputName ?? step.label}": ${step.instruction || step.label}`;
    case "decision":
      return `${n}. Decision — ${step.instruction || step.label} (see branching below).`;
    default:
      return `${n}. ${step.label}${detail}`;
  }
}

// ⚠️ D2 CAVEAT (spec §1.5): the brain INTERPRETS these branch/loop instructions — it is a language model
// following prose, NOT a deterministic DAG executor. This is an accepted trade-off (D2: "our Messages-API
// brain runs the recipe", no separate executor). The mitigation is to render branches/loops EXPLICITLY and
// unambiguously (numbered step targets, named options, concrete stop conditions — Flow's proven rendering)
// so the brain can follow them reliably. If branching reliability ever proves insufficient in practice, the
// documented fallback (spec §16) is to add a deterministic DAG executor — but do NOT silently assume exact
// control flow here. Keep step targets numeric + options named so the rendered text leaves no room to guess.
/** Render the recipe as the brain's seed-recipe text (the canonical, drift-free form). */
export function renderRecipeForBrain(recipe: CompiledRecipe): string {
  const lines: string[] = [
    `Run the "${recipe.name}" bundle — a fixed recipe (${recipe.description}). Do the steps IN ORDER, feeding each step's output into the next:`,
  ];
  for (const step of recipe.steps) {
    lines.push(stepLine(step));
    if (step.kind === "service") lines.push(...serviceUsageLines(step));
  }

  if (recipe.branches.length) {
    lines.push("", "Branching:");
    for (const b of recipe.branches) {
      const opts = b.options
        .map((o) => `if "${o.label}" → ${o.goToStepIndex != null ? `go to step ${o.goToStepIndex}` : "continue"}`)
        .join("; ");
      lines.push(`- After step ${b.fromStepIndex}${b.question ? ` (${b.question})` : ""}: ${opts}.`);
    }
  }

  if (recipe.loops.length) {
    lines.push("", "Loops:");
    for (const l of recipe.loops) {
      const body = l.bodyStepIndexes.length ? `step(s) ${l.bodyStepIndexes.join(", ")}` : "the loop body";
      const over = l.overRef ? ` for each ${l.overRef}` : "";
      const until = l.until ? ` until ${l.until}` : "";
      lines.push(`- Repeat ${body}${over}${until}.`);
    }
  }

  lines.push(
    "Use each step's pinned serviceId DIRECTLY (no need to search_services first). If a pinned service fails with provider_error/404, service_not_found, or no_payable_target, its endpoint is stale — retry it at most once, then search_services for an equivalent capability and use that instead (don't re-call a dead endpoint with tweaked inputs). EMPTY results still cost money: a paid call returning an empty set ({\"people\":[]}, {\"results\":[]}, {\"data\":[]}) was charged in full — it's almost always a too-narrow/wrong-shaped query (e.g. an exact job TITLE instead of a SENIORITY level), not missing data. Don't fire the same empty-returning shape at the next item: BROADEN or re-shape the query once on the same item (use the step's Example input / seniority vocabulary above), then switch providers if still empty. For a step that loops over many items, confirm the service returns ROWS on ONE item before fanning out. Treat the rest of the user's message as the bundle's input.",
  );
  return lines.join("\n");
}
