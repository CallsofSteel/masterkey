// Masterkey — quick-bar bundle generator (spec §12.1). Turns the catalog quick-bar's selected services +
// plain-English goal into a RUNNABLE bundle GRAPH (not just a SKILL.md), so "Generate" saves a bundle to the
// library that the user can Run via "/", open in the builder, or export. Reuses the proven graph-drafting
// brain (runAssist / draft_graph, which resolves endpoints from the registry and never invents them).
//
// Ask-first is preserved (§12.1): if the goal is too vague to draft a sensible bundle, the brain returns a
// clarifying question instead of a graph, and the quick bar shows it so the user can refine + re-generate.

import { runAssist } from "@/lib/studio/assist";
import type { BundleGraph } from "./types";

export type GenerateRecipeResult =
  | { mode: "graph"; name: string; description: string; graph: BundleGraph; reply: string }
  | { mode: "needs_confirmation"; message: string };

/** First ~8 words of the goal, title-cased — a readable fallback name when the brain didn't set one. */
function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ");
  const base = words.replace(/[.,;:!?]+$/g, "").slice(0, 60) || "New bundle";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export async function generateBundleRecipe(input: {
  serviceIds: string[];
  prompt: string;
  userId: string;
}): Promise<GenerateRecipeResult> {
  const serviceHint = input.serviceIds.length
    ? `\n\nThe user PRE-SELECTED these registry serviceIds — their explicit provider choices: ${input.serviceIds.join(", ")}.\n` +
      `Apply the respect / correct / supplement rule to each (see the "Honoring the user's service selection" policy): RESPECT a pick that's the right capability (use that exact service — never swap a fungible peer), CORRECT a pick that's the wrong capability for the goal (replace it, say why), and SUPPLEMENT with complementary endpoints the goal needs but the user didn't pick.`
    : "";

  const message =
    `Build a complete, runnable bundle for this goal:\n"${input.prompt}"${serviceHint}\n\n` +
    `Draft the WHOLE graph now with draft_graph — include an input node for each value the operator must supply, the service steps in order, any instruction/decision/loop steps, and an output. Set the bundle's name and a one-sentence description with set_metadata. ` +
    `Remember: do text work (writing/summarizing/deciding) in instruction nodes, not chat-completion services. ` +
    `In your reply, END with a one-line "Selection notes:" summarizing what you KEPT, what you CORRECTED (and why), and what you ADDED. ` +
    `If the goal is too vague to build a sensible bundle, DON'T draft — instead ask one brief clarifying question in your reply.`;

  const result = await runAssist({
    graph: { nodes: [], edges: [] },
    message,
    userId: input.userId,
  });

  // No graph drafted → treat the brain's reply as an ask-first clarifying prompt (§12.1 needs_confirmation).
  if (!result.graph.nodes.length) {
    return {
      mode: "needs_confirmation",
      message: result.reply?.trim() || "Tell me a bit more about what this bundle should do, and I'll build it.",
    };
  }

  const name = result.metadata?.name?.trim() || nameFromPrompt(input.prompt);
  const description = result.metadata?.description?.trim() || input.prompt.trim().slice(0, 200);
  return { mode: "graph", name, description, graph: result.graph, reply: result.reply };
}
