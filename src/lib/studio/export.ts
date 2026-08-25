// Masterkey — Bundle Studio export / takeaway (server-only; reads the registry). Spec §11 (and consumed by
// the §5.4 export route). Renders a saved bundle into either:
//   • a SKILL.md takeaway — for the user's OWN external agent, which pays per call with ITS OWN wallet over
//     x402 (NOT the platform). Distinct from running inside Masterkey (the platform pays), per §11.3.
//   • a JSON bundle — the graph + compiled recipe + per-service x402 endpoint detail.
//
// Both render from the SHARED CompiledRecipe (spec §1.4 anti-drift) — the brain renderer (renderRecipeForBrain)
// and this SKILL renderer differ only in FRAMING (run_service vs direct x402 call), never in the recipe data.

import type { Service } from "@/data/types";
import { findServiceById } from "@/lib/registry";
import { buildBundle, bundleToMarkdown } from "@/lib/bundle/format";
import { compileRecipe, type CompiledRecipe, type CompiledStep } from "./compile";
import type { BundleDoc } from "./types";

/** Unique, resolvable services referenced by the recipe's service steps (for the endpoint catalog). */
function recipeServices(recipe: CompiledRecipe): Service[] {
  const ids = [...new Set(recipe.steps.filter((s) => s.serviceId).map((s) => s.serviceId!))];
  return ids.map((id) => findServiceById(id)).filter((s): s is Service => !!s);
}

/** A step line for the EXTERNAL SKILL.md — frames service steps as a direct endpoint call (not run_service). */
function skillStepLine(step: CompiledStep): string {
  const n = step.index;
  const detail = step.instruction && step.instruction !== step.label ? ` — ${step.instruction}` : "";
  if (step.kind === "service" && step.serviceId) {
    const name = step.endpoint?.name ?? step.serviceId;
    const inputs =
      step.inputMap && Object.keys(step.inputMap).length
        ? ` Map inputs: ${Object.entries(step.inputMap).map(([k, v]) => `${k} ← ${v}`).join(", ")}.`
        : "";
    return `${n}. ${step.label}${detail} — call the **${name}** endpoint (see References § ${name}).${inputs}`;
  }
  if (step.kind === "input") return `${n}. Ask the operator for "${step.inputName ?? step.label}": ${step.instruction || step.label}`;
  if (step.kind === "decision") return `${n}. Decision — ${step.instruction || step.label} (see branching below).`;
  return `${n}. ${step.label}${detail}`;
}

function renderWorkflowForSkill(recipe: CompiledRecipe): string {
  const lines: string[] = ["## Workflow", ""];
  for (const s of recipe.steps) lines.push(skillStepLine(s));
  if (recipe.branches.length) {
    lines.push("", "### Branching");
    for (const b of recipe.branches) {
      const opts = b.options.map((o) => `if "${o.label}" → ${o.goToStepIndex != null ? `go to step ${o.goToStepIndex}` : "continue"}`).join("; ");
      lines.push(`- After step ${b.fromStepIndex}${b.question ? ` (${b.question})` : ""}: ${opts}.`);
    }
  }
  if (recipe.loops.length) {
    lines.push("", "### Loops");
    for (const l of recipe.loops) {
      const body = l.bodyStepIndexes.length ? `step(s) ${l.bodyStepIndexes.join(", ")}` : "the loop body";
      lines.push(`- Repeat ${body}${l.overRef ? ` for each ${l.overRef}` : ""}${l.until ? ` until ${l.until}` : ""}.`);
    }
  }
  return lines.join("\n");
}

/** Render a bundle as a SKILL.md takeaway for the user's own external agent (spec §11.1/§11.3). */
export function graphToSkillMd(bundle: BundleDoc): string {
  const recipe = compileRecipe(bundle);
  const services = recipeServices(recipe);
  const out: string[] = [];

  out.push("---");
  out.push(`name: ${bundle.slug}`);
  out.push(`description: >-`);
  out.push(`  ${bundle.description || bundle.name}`);
  out.push("---");
  out.push("");
  out.push(`# ${bundle.name}`);
  out.push("");
  if (bundle.description) out.push(bundle.description, "");

  out.push("> **How payment works:** this skill is a *takeaway* for your own agent. Your agent pays per call");
  out.push("> with **its own funded wallet** over the x402 protocol (USDC) — there is no Masterkey platform");
  out.push("> billing here. See the endpoint catalog in **References** for exact prices, networks, and payTo.");
  out.push("");

  if (recipe.inputs.length) {
    out.push("## Inputs", "");
    for (const i of recipe.inputs) out.push(`- \`${i.name}\` — ${i.prompt}`);
    out.push("");
  }

  out.push(renderWorkflowForSkill(recipe));
  out.push("");

  if (services.length) {
    out.push("## References — endpoint catalog", "");
    out.push(bundleToMarkdown(buildBundle(services)));
  }

  if (recipe.warnings.length) {
    out.push("", "## Notes");
    for (const w of recipe.warnings) out.push(`- ⚠️ ${w}`);
  }
  return out.join("\n");
}

/** Render a bundle as a JSON takeaway: metadata + compiled recipe + graph + the x402 endpoint catalog. */
export function bundleToExportJson(bundle: BundleDoc) {
  const recipe = compileRecipe(bundle);
  const services = recipeServices(recipe);
  return {
    schema: "masterkey.bundle.studio/v1",
    bundle: {
      slug: bundle.slug,
      name: bundle.name,
      description: bundle.description,
      trigger: bundle.trigger,
      inputs: recipe.inputs,
    },
    recipe,
    graph: bundle.graph ?? null,
    endpoints: buildBundle(services),
    note: "Takeaway bundle. Your own agent pays per call over x402 with its own wallet (not Masterkey).",
  };
}
