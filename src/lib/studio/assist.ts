// Masterkey — Bundle Studio AI build-assist brain (spec §8). The canvas chat bar's backend: given the
// CURRENT graph (§1.1 BundleGraph) + a user message, it edits the graph for the author — adding/updating/
// connecting/removing nodes, setting bundle metadata, or drafting a whole graph from a description — and
// replies in chat. Same Anthropic Messages API + key as the web brain (src/lib/agent/brain.ts) and the
// Bundle Composer (src/lib/bundle/skill.ts); this reuses skill.ts's registry tools + adaptive-strictness.
//
// MONEY-SAFE: this brain only READS the registry (search_registry / get_service_detail). It never calls a
// service, never pays. Service nodes carry only a registry id + a snapshot the SERVER copies verbatim from
// the registry — the model never invents endpoints (spec §8.5), and the real call is re-resolved fresh at
// run time by compileRecipe.
//
// CONTRACT: the model mutates a server-side working copy of the graph (so it can reference node ids it just
// created), recording each change as an AssistOp. It ends by calling `respond` with a chat message. The
// route returns { reply, ops, graph, metadata } — the client applies `graph` (full, via graphToCanvas) and
// renders `ops` as the "what changed" summary.

import Anthropic from "@anthropic-ai/sdk";
import { searchServices } from "@/lib/mcp/tools";
import { getStudioServiceDetail } from "@/lib/studio/services";
import { summarizeRunForReview } from "@/lib/studio/run-review";
import type { BundleGraph, BundleNode, BundleNodeData, BundleEdge, NodeKind, DecisionOption } from "./types";

const MODEL = process.env.MASTERKEY_BUNDLE_MODEL ?? process.env.MASTERKEY_AGENT_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 8000;
const MAX_ROUNDS = 10; // drafting a graph can fan out into several search/get_service_detail calls
const MAX_NODES = 60; // guardrail: keep a chat-built graph sane (the canvas hard cap is 200, §13.3)

const KINDS: NodeKind[] = ["purpose", "service", "instruction", "decision", "input", "output", "loop"];

// ─── Patch ops (what changed — for the chat "what changed" summary) ─────────────────────────────
export type AssistOp =
  | { op: "add_node"; kind: NodeKind; id: string; label: string }
  | { op: "update_node"; id: string; label: string }
  | { op: "remove_node"; id: string }
  | { op: "connect_nodes"; source: string; target: string }
  | { op: "set_metadata"; fields: string[] }
  | { op: "draft_graph"; nodes: number; edges: number };

export interface AssistResult {
  reply: string;
  ops: AssistOp[];
  graph: BundleGraph; // the resulting full graph — client applies it (graphToCanvas → atoms)
  metadata?: { name?: string; description?: string; trigger?: string };
}

export function isAssistConfigured(): boolean {
  return !!(process.env.CLAUDE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

const SYSTEM = `You are Masterkey's Bundle build-assistant. You edit a visual "bundle" workflow GRAPH for the author, live on their canvas, and reply conversationally. A bundle is a multi-step recipe that an autonomous agent later runs by calling real, pay-per-use x402 API services from Masterkey's registry.

You are given the CURRENT graph (nodes + edges) and the user's message. Use your tools to change the graph, then call \`respond\` with a short chat reply describing what you did (or asking a question).

## Node kinds
- purpose — the bundle's identity. Prefer \`set_metadata\` (name/description) over a purpose node.
- service — ONE registry service call. Requires a \`serviceId\` from the registry. Carries an optional \`inputMap\` (field → "{{nodeId.output}}" reference or literal) and \`instruction\` (a note on what this step does).
- instruction — a plain-English reasoning/transform step the running agent performs ITSELF (no service call).

## CRITICAL: the running agent is itself a capable LLM (Claude)
The agent that RUNS this bundle is a strong language model. So any step that is pure writing, summarizing, rewriting, extracting, classifying, scoring/ranking, deciding, or formatting — it does ITSELF in an \`instruction\` node. NEVER add a \`service\` node for a chat-completion / general LLM text model (e.g. "draft the email", "write a summary", "generate copy") — that is a wasteful, unnecessary paid API call for something the agent already does for free and better in-context. Reserve \`service\` nodes for capabilities the agent genuinely LACKS: live data (web search, scraping, social, people/email enrichment), media generation/editing (image, video, audio/TTS, transcription), sending/publishing (email, SMS, posting), payments, sandboxes, and similar external actions. When in doubt: "could a smart writer with these inputs just do this?" → \`instruction\`. "Does this need the outside world or a non-text modality?" → \`service\`.
- decision — branching: a \`question\` + \`options[]\`; each option becomes an output handle you connect onward.
- input — a value the operator supplies at run start (\`prompt\`, \`required\`, \`saveAs\` = the input name).
- output — final result shaping (\`format\`, \`template\`).
- loop — repeat body nodes over a collection (\`overRef\`) \`until\` a condition; \`bodyNodeIds\` = the loop body.

## Tools
- search_registry(query, category?, limit?) — find services/endpoints suited to a step. Call BEFORE adding a service so you pick a real id.
- get_service_detail(serviceId) — the real endpoints/price/payment for one service. Inspect this before adding a service to be sure it fits.
- get_run_result(runId) — read a finished/in-flight TEST run's transcript (status, cost, steps, errors/warnings). Use this to DEBUG: when the user asks you to review a test run, call it first, diagnose what failed or what's missing, then fix the graph with your mutation tools and explain the fix.
- add_node(kind, data, connectFrom?) — create a node. You choose its \`id\` (short, kebab, unique). For a service node, set data.serviceId to a real registry id — the SERVER attaches the real endpoint snapshot; NEVER write endpoint URLs/prices yourself. \`connectFrom\` (an existing node id) draws an edge into the new node.
- update_node(id, data) — patch fields on an existing node (merges).
- connect_nodes(source, target, sourceHandle?) — draw an edge. For a decision branch, pass the option id as sourceHandle.
- remove_node(id) — delete a node and its edges.
- set_metadata(name?, description?, trigger?) — set the bundle's identity.
- draft_graph(nodes[], edges[]) — replace the WHOLE graph in one shot (for "build me a bundle that does X"). Each node: {id, kind, data, position?}. Lay nodes out left→right with rising x (≈280 apart) and varied y. Still set service nodes via serviceId only.
- respond(message) — REQUIRED to end. Your chat reply to the user.

## Policy (adaptive strictness — mirrors the Bundle Composer)
- When the goal is CONCRETE and you can pick the right services, just build it: search the registry, choose the obviously-correct service per step, wire the steps, and report what you did in \`respond\`.
- When the request is AMBIGUOUS, under-specified, or several equally-good services fit a slot, make minimal safe changes (or none) and ASK a clarifying question in \`respond\` instead of guessing.
- Only ADD/REPLACE a service to fix a real gap or a wrong tool for the job; tell the user what changed and why.

## Honoring the user's service selection (IMPORTANT — respect / correct / supplement)
When the user has PRE-SELECTED specific services (their explicit provider choices), treat each as a deliberate pick and apply this three-way rule, then summarize what you did:
- RESPECT — if a selected service is the RIGHT capability for the goal, USE THAT EXACT service. Do NOT swap it for a similar/fungible alternative just because you'd pick differently (e.g. keep GPT Image 2 rather than switching to Flux/Nano Banana; keep CoinMarketCap rather than CoinGecko). The selection exists precisely so the user can pin a provider.
- CORRECT — if a selected service is the WRONG capability for what the goal actually needs, REPLACE it with the right endpoint and say why. Examples: they picked an image-EDIT endpoint but the goal is to GENERATE an image; they picked a COMPANY-data enrichment (funding/competitors/news/HQ/size) but the goal is to find the PEOPLE at a company (who works there, their roles, socials, email). Fix the capability; keep their intent.
- SUPPLEMENT — the user likely doesn't know every endpoint that would help. Add complementary services the goal clearly benefits from even if unselected (e.g. after people-enrichment, add a socials / LinkedIn / X / web-research step to go deeper; after finding an email, a verification step). Don't sprawl — add only what the stated goal warrants.
- Fungibility test for "correct vs. respect": only swap a user-picked service when it's the WRONG capability, never when it's a fungible peer of what you'd choose.
- If you find an existing \`service\` node doing pure text work the agent could do itself (a chat-completion / LLM "draft/summarize/rewrite" step), REPLACE it with an \`instruction\` node and say so — it removes an unnecessary paid call.
- NEVER invent service endpoints, prices, or payTo addresses — they come only from the registry via the server.
- Honor outward/irreversible steps (send/pay/publish): note that the running agent must confirm with a human.
- Keep graphs reasonable (a few to ~a dozen nodes); don't sprawl.`;

const NODE_DATA_PROPS = {
  label: { type: "string", description: "Short human label shown on the node." },
  serviceId: { type: "string", description: "service nodes: a real Masterkey registry id (or 'apify:<actorId>')." },
  backendProviderId: { type: "string", description: "service nodes: pin a specific backend (omit → recommended/first-party)." },
  operation: { type: "string", description: "service nodes (api kind): the operation name." },
  inputMap: { type: "object", description: "service nodes: field → '{{nodeId.output}}' reference or a literal value.", additionalProperties: { type: "string" } },
  instruction: { type: "string", description: "instruction nodes (or a service node's step note)." },
  question: { type: "string", description: "decision nodes: the branching question." },
  options: {
    type: "array",
    description: "decision nodes: branch options.",
    items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] },
  },
  prompt: { type: "string", description: "input nodes: what to ask the operator." },
  required: { type: "boolean", description: "input nodes: is this value required?" },
  saveAs: { type: "string", description: "input nodes: the bundle input name to store under." },
  format: { type: "string", description: "output nodes: the result format (e.g. 'Markdown report')." },
  template: { type: "string", description: "output nodes: the output template." },
  overRef: { type: "string", description: "loop nodes: '{{nodeId.output}}' reference to the collection to iterate." },
  until: { type: "string", description: "loop nodes: plain-English stop condition." },
  bodyNodeIds: { type: "array", items: { type: "string" }, description: "loop nodes: ids of the nodes forming the loop body." },
} as const;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_registry",
    description: "Search the Masterkey registry for services/endpoints suited to a step. Returns summaries (id, name, description, category, price). Call before adding a service node.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability to search for, e.g. 'generate image', 'web search', 'send email'." },
        category: { type: "string", description: "Optional category/subcategory slug to scope the search." },
        limit: { type: "number", description: "Max results (default 12)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_service_detail",
    description: "Fetch one service's real endpoints, methods, schemas, and exact x402 payment for a registry serviceId. Inspect before adding a service so you know it fits.",
    input_schema: { type: "object", properties: { serviceId: { type: "string" } }, required: ["serviceId"] },
  },
  {
    name: "get_run_result",
    description: "Read a TEST run's transcript (status, cost, ordered steps, errors/warnings) to debug the bundle. Call this when asked to review a run, then fix the graph.",
    input_schema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
  },
  {
    name: "add_node",
    description: "Create a node on the canvas. Choose a short kebab-case id. For service nodes set data.serviceId only — the server attaches the real endpoint.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A short, unique, kebab-case node id you choose (e.g. 'fetch-image')." },
        kind: { type: "string", enum: KINDS },
        data: { type: "object", properties: NODE_DATA_PROPS },
        connectFrom: { type: "string", description: "Optional: an existing node id to draw an edge FROM, into this new node." },
        position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
      },
      required: ["id", "kind", "data"],
    },
  },
  {
    name: "update_node",
    description: "Patch fields on an existing node (shallow merge into data). Use to refine labels, inputMap, instructions, etc.",
    input_schema: { type: "object", properties: { id: { type: "string" }, data: { type: "object", properties: NODE_DATA_PROPS } }, required: ["id", "data"] },
  },
  {
    name: "connect_nodes",
    description: "Draw an edge between two existing nodes. For a decision branch, pass the option id as sourceHandle.",
    input_schema: {
      type: "object",
      properties: { source: { type: "string" }, target: { type: "string" }, sourceHandle: { type: "string" } },
      required: ["source", "target"],
    },
  },
  {
    name: "remove_node",
    description: "Delete a node and any edges touching it.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "set_metadata",
    description: "Set the bundle's identity (name/description/trigger). Prefer this over a purpose node.",
    input_schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, trigger: { type: "string" } } },
  },
  {
    name: "draft_graph",
    description: "Replace the WHOLE graph from scratch (for 'build a bundle that does X'). Service nodes set data.serviceId only.",
    input_schema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: KINDS },
              data: { type: "object", properties: NODE_DATA_PROPS },
              position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
            },
            required: ["id", "kind", "data"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: { source: { type: "string" }, target: { type: "string" }, sourceHandle: { type: "string" } },
            required: ["source", "target"],
          },
        },
      },
      required: ["nodes", "edges"],
    },
  },
  {
    name: "respond",
    description: "Emit your chat reply to the user. REQUIRED to end the turn.",
    input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
];

function toKind(t: unknown): NodeKind {
  return KINDS.includes(t as NodeKind) ? (t as NodeKind) : "instruction";
}

// Whitelist + coerce model-supplied node data into BundleNodeData. For service nodes, resolve the real
// endpoint snapshot from the registry (never trust a model-written endpoint) — spec §8.5.
async function buildNodeData(kind: NodeKind, raw: Record<string, unknown>): Promise<BundleNodeData> {
  const d: BundleNodeData = { label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : kind };
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);

  if (kind === "service") {
    const serviceId = str("serviceId");
    if (serviceId) {
      d.serviceId = serviceId;
      if (str("backendProviderId")) d.backendProviderId = str("backendProviderId");
      if (str("operation")) d.operation = str("operation");
      // Copy the registry endpoint snapshot VERBATIM — the model never writes endpoints itself.
      const resolved = await getStudioServiceDetail(serviceId).catch(() => null);
      if (resolved) {
        d.endpoint = resolved.bundle;
        if (!raw.label || d.label === "service") d.label = resolved.bundle.name;
      }
      if (raw.inputMap && typeof raw.inputMap === "object") {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.inputMap as Record<string, unknown>)) if (typeof v === "string") map[k] = v;
        if (Object.keys(map).length) d.inputMap = map;
      }
    }
  }
  if (str("instruction")) d.instruction = str("instruction");
  if (kind === "decision") {
    if (str("question")) d.question = str("question");
    if (Array.isArray(raw.options)) {
      d.options = (raw.options as Record<string, unknown>[])
        .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
        .map((o): DecisionOption => ({ id: o.id as string, label: o.label as string }));
    }
  }
  if (kind === "input") {
    if (str("prompt")) d.prompt = str("prompt");
    if (typeof raw.required === "boolean") d.required = raw.required as boolean;
    if (str("saveAs")) d.saveAs = str("saveAs");
  }
  if (kind === "output") {
    if (str("format")) d.format = str("format");
    if (str("template")) d.template = str("template");
  }
  if (kind === "loop") {
    if (str("overRef")) d.overRef = str("overRef");
    if (str("until")) d.until = str("until");
    if (Array.isArray(raw.bodyNodeIds)) d.bodyNodeIds = (raw.bodyNodeIds as unknown[]).filter((x): x is string => typeof x === "string");
  }
  return d;
}

function pos(raw: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  const p = raw as { x?: unknown; y?: unknown } | undefined;
  return p && typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : fallback;
}

let _edgeSeq = 0;
function edgeId(source: string, target: string): string {
  return `e_${source}_${target}_${_edgeSeq++}`;
}

export async function runAssist(input: {
  graph: BundleGraph;
  message: string;
  focusNodeId?: string;
  name?: string;
  description?: string;
  userId?: string; // required for get_run_result (ownership-checked transcript reads)
  reviewRunId?: string; // a just-finished test run the user wants reviewed/debugged (debug loop)
}): Promise<AssistResult> {
  const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "" });

  // Working copy the model mutates round-to-round (so it can reference ids it just created).
  const nodes: BundleNode[] = (input.graph?.nodes ?? []).map((n) => ({ ...n, data: { ...n.data } }));
  const edges: BundleEdge[] = (input.graph?.edges ?? []).map((e) => ({ ...e }));
  const ops: AssistOp[] = [];
  const metadata: { name?: string; description?: string; trigger?: string } = {};
  const byId = (id: string) => nodes.find((n) => n.id === id);
  let addCount = 0;

  async function applyTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "search_registry": {
        const query = typeof args.query === "string" ? args.query : "";
        const category = typeof args.category === "string" ? args.category : undefined;
        const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 25) : 12;
        return searchServices({ query, category, limit });
      }
      case "get_service_detail": {
        const id = typeof args.serviceId === "string" ? args.serviceId : "";
        const r = await getStudioServiceDetail(id).catch(() => null);
        return r ? r.detail : { error: `service '${id}' not found` };
      }
      case "get_run_result": {
        const id = typeof args.runId === "string" ? args.runId : "";
        if (!input.userId) return { error: "run review unavailable (no user context)" };
        return summarizeRunForReview(id, input.userId).catch(() => ({ found: false, note: "could not read the run" }));
      }
      case "add_node": {
        if (nodes.length >= MAX_NODES) return { error: `node limit (${MAX_NODES}) reached` };
        const kind = toKind(args.kind);
        let id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : `n_${addCount}`;
        if (byId(id)) id = `${id}-${nodes.length}`; // de-collide
        const data = await buildNodeData(kind, (args.data ?? {}) as Record<string, unknown>);
        const position = pos(args.position, { x: 120 + addCount * 280, y: 120 + (addCount % 3) * 150 });
        nodes.push({ id, kind, position, data });
        addCount++;
        if (typeof args.connectFrom === "string" && byId(args.connectFrom)) {
          edges.push({ id: edgeId(args.connectFrom, id), source: args.connectFrom, target: id });
          ops.push({ op: "connect_nodes", source: args.connectFrom, target: id });
        }
        ops.push({ op: "add_node", kind, id, label: data.label });
        return { ok: true, id, kind };
      }
      case "update_node": {
        const id = typeof args.id === "string" ? args.id : "";
        const node = byId(id);
        if (!node) return { error: `node '${id}' not found` };
        const patch = await buildNodeData(node.kind, { label: node.data.label, ...(args.data as Record<string, unknown>) });
        node.data = { ...node.data, ...patch };
        ops.push({ op: "update_node", id, label: node.data.label });
        return { ok: true, id };
      }
      case "connect_nodes": {
        const source = typeof args.source === "string" ? args.source : "";
        const target = typeof args.target === "string" ? args.target : "";
        if (!byId(source) || !byId(target)) return { error: "source or target node not found" };
        const sourceHandle = typeof args.sourceHandle === "string" ? args.sourceHandle : undefined;
        if (edges.some((e) => e.source === source && e.target === target && e.sourceHandle === sourceHandle)) return { ok: true, note: "edge already exists" };
        edges.push({ id: edgeId(source, target), source, target, ...(sourceHandle ? { sourceHandle } : {}) });
        ops.push({ op: "connect_nodes", source, target });
        return { ok: true };
      }
      case "remove_node": {
        const id = typeof args.id === "string" ? args.id : "";
        const idx = nodes.findIndex((n) => n.id === id);
        if (idx < 0) return { error: `node '${id}' not found` };
        nodes.splice(idx, 1);
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i].source === id || edges[i].target === id) edges.splice(i, 1);
        ops.push({ op: "remove_node", id });
        return { ok: true };
      }
      case "set_metadata": {
        const fields: string[] = [];
        for (const k of ["name", "description", "trigger"] as const) {
          if (typeof args[k] === "string") {
            metadata[k] = args[k] as string;
            fields.push(k);
          }
        }
        ops.push({ op: "set_metadata", fields });
        return { ok: true };
      }
      case "draft_graph": {
        const rawNodes = Array.isArray(args.nodes) ? (args.nodes as Record<string, unknown>[]) : [];
        const rawEdges = Array.isArray(args.edges) ? (args.edges as Record<string, unknown>[]) : [];
        if (rawNodes.length > MAX_NODES) return { error: `too many nodes (max ${MAX_NODES})` };
        const built: BundleNode[] = [];
        for (let i = 0; i < rawNodes.length; i++) {
          const rn = rawNodes[i];
          const kind = toKind(rn.kind);
          const id = typeof rn.id === "string" && rn.id.trim() ? rn.id.trim() : `n_${i}`;
          const data = await buildNodeData(kind, (rn.data ?? {}) as Record<string, unknown>);
          built.push({ id, kind, position: pos(rn.position, { x: 120 + i * 280, y: 140 + (i % 3) * 150 }), data });
        }
        const ids = new Set(built.map((n) => n.id));
        const builtEdges: BundleEdge[] = rawEdges
          .filter((e) => typeof e.source === "string" && typeof e.target === "string" && ids.has(e.source as string) && ids.has(e.target as string))
          .map((e) => ({
            id: edgeId(e.source as string, e.target as string),
            source: e.source as string,
            target: e.target as string,
            ...(typeof e.sourceHandle === "string" ? { sourceHandle: e.sourceHandle } : {}),
          }));
        nodes.length = 0;
        nodes.push(...built);
        edges.length = 0;
        edges.push(...builtEdges);
        ops.push({ op: "draft_graph", nodes: built.length, edges: builtEdges.length });
        return { ok: true, nodes: built.length, edges: builtEdges.length };
      }
      default:
        return { error: `unknown tool '${name}'` };
    }
  }

  // Seed the conversation with the current graph + the user's message.
  const focus = input.focusNodeId && byId(input.focusNodeId);
  const graphJson = JSON.stringify({ name: input.name, description: input.description, nodes, edges }, null, 1);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `CURRENT GRAPH:\n${graphJson}\n\n` +
        (focus ? `The user has FOCUSED node "${focus.id}" (${focus.kind}: ${focus.data.label}).\n\n` : "") +
        (input.reviewRunId
          ? `A TEST RUN of this bundle just finished (runId "${input.reviewRunId}"). Call get_run_result on it FIRST, then diagnose what happened — if it failed or a step misbehaved, fix the graph; if it ran clean, say so plainly.\n\n`
          : "") +
        `USER MESSAGE:\n${input.message}\n\nEdit the graph with your tools as needed, then call respond.`,
    },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: TOOLS,
      tool_choice: lastRound ? { type: "tool", name: "respond" } : { type: "auto" },
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const respondCall = toolUses.find((b) => b.name === "respond");

    // If the model is done (called respond) — but first apply any other tools it batched alongside it.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === "respond") continue;
      const out = await applyTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }

    if (respondCall) {
      const reply = ((respondCall.input as { message?: string })?.message ?? "").trim() || "Done.";
      return { reply, ops, graph: { nodes, edges }, metadata: Object.keys(metadata).length ? metadata : undefined };
    }

    if (!toolUses.length) {
      // Model answered in plain text — treat it as the reply (no graph change this turn).
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { reply: text || "Done.", ops, graph: { nodes, edges }, metadata: Object.keys(metadata).length ? metadata : undefined };
    }

    messages.push({ role: "user", content: results });
  }

  // Unreachable (last round forces respond), but keep the contract total.
  return { reply: "Done.", ops, graph: { nodes, edges }, metadata: Object.keys(metadata).length ? metadata : undefined };
}
