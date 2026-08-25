// studio-routing.mts — regression gate for Bundle Studio BRANCH + LOOP routing (spec §1.3 / §9.3).
// Pure functions only (no network, no wallet, no DB): canvasToGraph + compileRecipe + renderRecipeForBrain.
//   npx tsx scripts/test/studio-routing.mts
// Exits non-zero on any failed assertion.
//
// Why this exists — two authoring bugs silently destroyed routing, and BOTH were invisible at the compile
// layer because the compiler was correct; the CANVAS simply never supplied the data:
//   1. workflow-canvas `onConnectStart` captured params.nodeId but not params.handleId, so an edge dragged
//      from a decision's per-option handle lost its `sourceHandle` -> compile.ts couldn't match the option
//      to a target -> "go to step 4" silently degraded to "continue" (no routing at all).
//   2. LoopEditor had no UI for `bodyNodeIds`, so every canvas-authored loop compiled with an empty body
//      -> the vague "Repeat the loop body" instead of the spec's "Repeat step(s) X-Y".
// The NEGATIVE controls below pin the exact broken output, so a regression is caught as a behavior change
// rather than a silently weaker prompt.
import { canvasToGraph } from "../../src/lib/studio/serialize";
import { compileRecipe, renderRecipeForBrain } from "../../src/lib/studio/compile";
import type { WorkflowNode, WorkflowEdge } from "../../src/lib/studio/workflow-store";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`✗ ${name}\n    got:  ${g}\n    want: ${w}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { label: id, type, ...data } }) as unknown as WorkflowNode;

/** A minimal decision(2 options) + loop(1 body step) graph, as the canvas would hand it over. */
function buildCanvas(opts: { withSourceHandle: boolean; withBodyNodeIds: boolean }) {
  const nodes: WorkflowNode[] = [
    node("in-mode", "input", { prompt: "A or B?", required: true }),
    node("decide", "decision", {
      question: "Pick a path",
      options: [
        { id: "opt-a", label: "A path" },
        { id: "opt-b", label: "B path" },
      ],
    }),
    node("step-a", "instruction", { instruction: "Output BRANCH=A" }),
    node("step-b", "instruction", { instruction: "Output BRANCH=B" }),
    node("loop", "loop", {
      overRef: "{{in-list.output}}",
      until: "all items done",
      ...(opts.withBodyNodeIds ? { bodyNodeIds: ["body"] } : {}),
    }),
    node("body", "instruction", { instruction: "Handle one item" }),
  ];
  const edges: WorkflowEdge[] = [
    { id: "e1", source: "in-mode", target: "decide" },
    // The gesture under test: an edge leaving a decision's per-option handle.
    { id: "e2", source: "decide", target: "step-a", ...(opts.withSourceHandle ? { sourceHandle: "opt-a" } : {}) },
    { id: "e3", source: "decide", target: "step-b", ...(opts.withSourceHandle ? { sourceHandle: "opt-b" } : {}) },
    { id: "e4", source: "step-a", target: "loop" },
    { id: "e5", source: "step-b", target: "loop" },
    { id: "e6", source: "loop", target: "body" },
  ] as unknown as WorkflowEdge[];
  return { nodes, edges };
}

function compileCanvas(opts: { withSourceHandle: boolean; withBodyNodeIds: boolean }) {
  const { nodes, edges } = buildCanvas(opts);
  const graph = canvasToGraph(nodes, edges);
  const recipe = compileRecipe({ slug: "t", name: "T", description: "d", graph } as never);
  return { graph, recipe, text: renderRecipeForBrain(recipe) };
}

// ==================== 1. canvasToGraph must carry sourceHandle through ====================
{
  const { graph } = compileCanvas({ withSourceHandle: true, withBodyNodeIds: true });
  const e2 = graph.edges.find((e) => e.id === "e2");
  eq("serialize: sourceHandle survives canvasToGraph", e2?.sourceHandle, "opt-a");
}

// ==================== 2. FIXED: option handles resolve to numeric step targets ====================
{
  const { recipe, text } = compileCanvas({ withSourceHandle: true, withBodyNodeIds: true });
  eq("compile: no warnings", recipe.warnings, []);
  eq("compile: one branch", recipe.branches.length, 1);
  const opts = recipe.branches[0].options;
  ok("branch A resolves to a step", opts[0].goToStepIndex != null, `got ${JSON.stringify(opts[0])}`);
  ok("branch B resolves to a step", opts[1].goToStepIndex != null, `got ${JSON.stringify(opts[1])}`);
  eq("branch A -> step 3", opts[0].goToStepIndex, 3);
  eq("branch B -> step 4", opts[1].goToStepIndex, 4);
  ok("render: numeric branch targets", /if "A path" → go to step 3; if "B path" → go to step 4/.test(text), text);
  ok("render: no degraded 'continue'", !text.includes("→ continue"), text);
}

// ==================== 3. NEGATIVE CONTROL: the pre-fix canvas output ====================
// Pins the exact damage of bug #1 so it can't creep back unnoticed.
{
  const { recipe, text } = compileCanvas({ withSourceHandle: false, withBodyNodeIds: true });
  eq("no-handle: branch targets unresolved", recipe.branches[0].options.map((o) => o.goToStepIndex ?? null), [null, null]);
  ok("no-handle: renders the degraded 'continue'", text.includes("→ continue"), text);
  ok("no-handle: compiler warns", recipe.warnings.length > 0, JSON.stringify(recipe.warnings));
}

// ==================== 4. FIXED: loop body renders explicit step numbers ====================
{
  const { recipe, text } = compileCanvas({ withSourceHandle: true, withBodyNodeIds: true });
  eq("loop: one loop", recipe.loops.length, 1);
  eq("loop: body step indexes", recipe.loops[0].bodyStepIndexes, [6]);
  ok("render: 'Repeat step(s) 6'", text.includes("Repeat step(s) 6 for each {{in-list.output}} until all items done"), text);
}

// ==================== 5. NEGATIVE CONTROL: loop with no body ====================
{
  const { recipe, text } = compileCanvas({ withSourceHandle: true, withBodyNodeIds: false });
  eq("no-body: empty bodyStepIndexes", recipe.loops[0].bodyStepIndexes, []);
  ok("no-body: falls back to vague wording", text.includes("Repeat the loop body"), text);
}

// ==================== 6. The live-run probe fixture compiles clean ====================
{
  const probe = (await import("./fixtures/routing-probe.json", { with: { type: "json" } })).default;
  const recipe = compileRecipe(probe as never);
  const text = renderRecipeForBrain(recipe);
  eq("routing-probe: no warnings", recipe.warnings, []);
  eq("routing-probe: 1 branch / 1 loop", [recipe.branches.length, recipe.loops.length], [1, 1]);
  ok("routing-probe: branch has numeric targets",
    recipe.branches[0].options.every((o) => o.goToStepIndex != null),
    JSON.stringify(recipe.branches[0].options));
  ok("routing-probe: loop names its body step", recipe.loops[0].bodyStepIndexes.length === 1, JSON.stringify(recipe.loops[0]));
  ok("routing-probe: renders both routings",
    /go to step \d+/.test(text) && /Repeat step\(s\) \d+/.test(text), text);
}

console.log(fails.length ? fails.join("\n") + "\n" : "");
console.log(`studio-routing tests: ${pass} passed, ${fails.length} failed.`);
process.exit(fails.length ? 1 : 0);
