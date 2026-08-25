// Masterkey — Bundle Studio shared types (isomorphic, types-only; safe on server & client).
//
// The unified data model for "Bundle Studio" (BUNDLE_STUDIO_SPEC.md §1.1). A Bundle is the single saved
// artifact authored either by the quick "describe → generate" bar or the full visual canvas. The GRAPH is
// the source of truth; the run-recipe the brain executes and the SKILL.md takeaway are both DERIVED from it
// (see src/lib/studio/compile.ts + export.ts). Curated linear bundles remain valid — a straight line is a
// trivial graph, and the compiler also accepts the legacy `steps[]` shape unchanged.
//
// This file EXTENDS, never forks, the existing primitives:
//   • BundleStep / inputs[] — from src/lib/bundles.ts (the legacy linear curated recipe).
//   • BundleService          — from src/lib/bundle/format.ts (the embedded, export-ready endpoint detail).
// We `import type` them so this module stays isomorphic (the type imports are erased at compile, so
// bundles.ts's node:fs/path runtime never leaks into client bundles).

import type { BundleStep } from "@/lib/bundles";
import type { BundleService } from "@/lib/bundle/format";

/** The kinds of node the canvas can place. Ported from Flow, re-pointed at our registry + brain. */
export type NodeKind =
  | "purpose" // bundle name/description/when-to-use → bundle metadata
  | "service" // a registry service call (run_service), registry-backed (no live probe)
  | "instruction" // a plain-English reasoning step the brain performs (no service call)
  | "decision" // branching: a question + options → multiple output handles → edges
  | "input" // an operator-supplied value collected at run start → bundle inputs[]
  | "output" // final result shaping
  | "loop"; // v1 loop semantics: repeat body nodes over a collection / until a condition

/** A branch target for a decision node — one option per output handle. */
export interface DecisionOption {
  id: string;
  label: string;
  goToNodeId?: string; // the node this option routes to (resolved into an edge)
}

/**
 * Per-node payload. A flat bag (mirrors Flow + @xyflow/react's `node.data`) with the per-kind fields
 * documented inline. The index signature keeps it forward-compatible with canvas-only display state.
 */
export interface BundleNodeData {
  label: string;

  // --- service node ---
  serviceId?: string; // Masterkey registry id (or "apify:<actorId>")
  backendProviderId?: string; // pinned backend; omitted → first-party / recommended default at run time
  operation?: string; // api-kind operation name
  endpoint?: BundleService; // SNAPSHOT from format.serviceToBundle() for display/export — re-resolved FRESH at compile
  inputMap?: Record<string, string>; // field -> template ref ("{{nodeId.path}}") or literal

  // --- instruction node ---
  instruction?: string;

  // --- decision node ---
  question?: string;
  options?: DecisionOption[];

  // --- input node ---
  prompt?: string;
  required?: boolean;
  saveAs?: string; // the bundle input name this maps to

  // --- output node ---
  format?: string;
  template?: string;

  // --- loop node ---
  overRef?: string; // template ref to the collection to iterate
  until?: string; // a stop condition expressed in plain English
  bodyNodeIds?: string[]; // the node ids that form the loop body

  [k: string]: unknown;
}

export interface BundleNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  data: BundleNodeData;
}

export interface BundleEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string; // e.g. a decision node's per-option output handle
  targetHandle?: string;
}

export interface BundleGraph {
  nodes: BundleNode[];
  edges: BundleEdge[];
}

/** How a saved bundle came to exist (drives badges + which fields are present). */
export type BundleSource = "quick" | "studio" | "curated";

/** A bundle is `ready` once it passes the whole-bundle E2E test (spec §10 / D6); else `draft`. */
export type BundleStatus = "draft" | "ready";

/**
 * The stored bundle. User bundles live in Mongo (COLLECTIONS.bundles); curated bundles keep loading from
 * data/bundles/*.json via src/lib/bundles.ts and are merged in (ownerUserId === null). The compiler accepts
 * EITHER `graph` (studio/quick) or `steps` (legacy linear/curated) — see compile.ts.
 */
export interface BundleDoc {
  _id: string; // "bndl_…"
  slug: string; // see SLUG SCOPING below — drives the "/" command
  name: string;
  description: string;
  trigger?: string;
  ownerUserId: string | null; // null = curated/global
  source: BundleSource;
  graph?: BundleGraph; // present for studio/quick bundles
  steps?: BundleStep[]; // legacy linear recipe (curated files); compiler accepts either
  inputs?: { name: string; prompt: string }[];
  status: BundleStatus; // "ready" once it passes the E2E test (D6)
  lastTestedISO?: string;
  createdISO: string;
  updatedISO: string;
}

// ── SLUG SCOPING (spec §1.2) ──────────────────────────────────────────────────────────────────────
// The `slug` drives the "/" command. Scoping rules:
//   • CURATED slugs (ownerUserId === null) are GLOBAL — unique across the whole catalog.
//   • USER slugs are unique PER OWNER. Two different users may each own a "/my-flow"; they never collide
//     because uniqueness is enforced on the compound (ownerUserId, slug) — see src/lib/mcp/indexes.ts (§1.8).
//   • RESOLUTION prefers the signed-in user's OWN bundle, then falls back to the curated/global one. So if a
//     user authors "/news-clip", their version shadows the curated "/news-clip" for them only. This is the
//     contract getBundleBySlug(slug, userId) implements (own-then-curated) — see src/lib/studio/store.ts (§1.9)
//     and the run-creation resolver (§6.2). Anonymous callers resolve curated-only.
//   • Slug format: ^[a-z0-9-]+$ (matches the existing guard in bundles.ts getBundle()).
export const SLUG_RE = /^[a-z0-9-]+$/;
