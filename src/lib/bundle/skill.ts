// Masterkey — Bundle Creator brain. Given the user's selected services (full registry detail) and a
// plain-English goal, it authors a Claude Agent SKILL.md that ties the selected x402 endpoints into an
// ordered workflow for a *different* agent to take away and run. Uses the same Anthropic Messages API +
// key as the web brain (src/lib/agent/brain.ts).
//
// ADAPTIVE STRICTNESS (not blind strict): when the user is confident and their picks fit the goal, it
// orchestrates ONLY the selected services. But when the user signals uncertainty ("not sure", "help me",
// "find…") OR a selected service is the WRONG tool for the goal (e.g. a generate-only image model when
// the goal is to EDIT an existing image), it consults the FULL registry (search_registry +
// get_service_detail tools) to find the right endpoint — correcting a clear mistake inline (documented)
// or, when the choice is genuinely ambiguous, returning a needs_confirmation result so the UI can help
// the user pick BEFORE the skill is written. It never replaces a service the user chose correctly.

import Anthropic from "@anthropic-ai/sdk";
import type { Service } from "@/data/types";
import { buildBundle, bundleToMarkdown, serviceToBundle } from "@/lib/bundle/format";
import { searchServices } from "@/lib/mcp/tools";
import { findServiceById } from "@/lib/registry";

const MODEL = process.env.MASTERKEY_BUNDLE_MODEL ?? process.env.MASTERKEY_AGENT_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 8000;
const MAX_ROUNDS = 6;

const SYSTEM = `You are Masterkey's Bundle Composer. You write a single Claude Agent **SKILL.md** that a DIFFERENT autonomous agent will take away and use to accomplish the user's goal by calling a curated set of real, pay-per-use x402 API services.

You are given:
1. A BUNDLE: the user's SELECTED services with REAL endpoints, methods, input/output schemas, exact x402 payment requirements (network, asset, payTo, raw amount), model selectors, async-poll details, and usage notes.
2. The user's GOAL.

You also have TOOLS to consult the FULL Masterkey registry beyond the selection:
- search_registry(query, category?, limit?) — find services/endpoints suited to the goal.
- get_service_detail(serviceId) — fetch one service's real endpoints + payment + schemas (call this BEFORE adding or recommending any service, so you copy its endpoints/prices/payTo VERBATIM).
- finalize(...) — emit your final result (REQUIRED to end). Either the SKILL.md, or a request for the user to confirm a changed selection.

## Strictness policy (IMPORTANT)
Default to STRICT: orchestrate ONLY the selected services. BUT override strictness in these cases:

1. CONFIDENT + selection fits → strict. Use only the selected services that the goal needs. Any selected service you do NOT use must be reported in finalize.recommendations with action "unused" and a one-line reason (e.g. "redundant with X" or "not needed for this goal"). Never silently drop a selection.

2. A selected service is CLEARLY the right tool → keep it. NEVER replace a service the user chose correctly.

3. CONSULT THE REGISTRY (search_registry + get_service_detail) whenever the user signals uncertainty, OR a selected service is the WRONG capability for the goal (e.g. an image GENERATE-only model when the goal is to EDIT an existing image; no web-search/social-research service when the goal needs to research people; only shallow enrichment when the goal needs deep social/content research), OR a clearly-needed capability is missing. Then choose how to finalize:
   a. ASK FIRST → finalize mode="needs_confirmation" when the user EXPLICITLY wants help choosing — cues like "not sure which", "I'm not sure", "help me pick/choose", "which should I use", "find me the right ones", "what do I need" — OR the request is too vague to pin specific services, OR several equally-good options exist for a needed slot. Do NOT write the skill yet. Provide a short \`message\` to the user explaining what you found, \`proposedServiceIds\` (registry ids to ADD), and optional \`questions\`. The UI lets them confirm, then you'll be re-invoked (with confirmation) to write the skill.
   b. FIX/ADD INLINE → finalize mode="skill" when the user gave a CONCRETE goal and is otherwise confident, but (i) a selected service can't do what the goal needs, or (ii) ONE clearly-needed capability is missing. Use the single obviously-correct endpoint, keep every correctly-chosen selection, record each change in finalize.recommendations (action "added"/"replaced" with serviceId/replaces + reason), AND document it prominently in the SKILL.md under a "## Changes to your selection" section.

Rule of thumb: only change the user's selection to FIX A MISTAKE or FILL A GAP — and when you do, tell them (recommendations + the Changes section). When the user is asking you to help them CHOOSE, or you cannot decide for them, ASK FIRST (needs_confirmation) rather than writing the skill. When the re-invocation has confirmed=true, never ask again — finalize mode="skill".

## Authoring rules
- Copy endpoint URLs, methods, prices, networks, and payTo addresses VERBATIM from the BUNDLE or from get_service_detail. NEVER invent or guess them.
- Payment model: the receiving agent pays each call itself in USDC over x402 (no API key); it needs a funded wallet on the listed network(s). State this.
- Honor needsApproval: for any outward/irreversible endpoint (send/mail/purchase/publish), instruct the agent to confirm with a human before calling.
- If the GOAL implies judging/qualifying/ranking items or people ("good match", "good candidate", "qualify", "score", "shortlist"), include an EXPLICIT qualification/scoring step in the Workflow (define the criteria and the keep/drop decision) — do not leave it implicit.
- If an endpoint's input fields are NOT given in the data (inputSchema is null AND the usage describes a different operation/endpoint), you may infer them from the provider's standard API, but MARK them in the SKILL.md as "(inferred — verify before relying on it)".

## SKILL.md shape (this is finalize.skill — file content ONLY, starts with the YAML frontmatter ---)
---
name: <kebab-case from the goal>
description: <one sentence: what this skill does + when to use it>
---

# <Title>

## Objective
<what success looks like, from the goal>

## How payment works
<x402 / USDC / own wallet, 2-3 lines>

## Changes to your selection
<ONLY if you added/replaced/dropped a service vs what the user selected — what changed and why; otherwise omit this section>

## Services
<for EACH service used: short what-it-does, then endpoint(s) with METHOD + URL, price, payment (network · asset · payTo · amount), required model selector, key input fields, where the output is — verbatim>

## Workflow
<numbered steps mapping the goal to the call sequence; for each step name the service/endpoint, the inputs (incl. which prior step's output to pass), and what to do with the result. Include qualification/scoring steps and async polling where relevant.>

## Inputs to provide
<values the operator must supply up front>

## Not used
<ONLY if the user selected services you did not use — list them + why; otherwise omit>`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_registry",
    description:
      "Search the FULL Masterkey registry (beyond the user's selection) for services/endpoints best suited to the goal. Use ONLY when the user is uncertain or a selected service is the wrong tool for the job. Returns service summaries (id, name, description, category, price).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability to search for, e.g. 'edit existing image', 'web search', 'social profile research'." },
        category: { type: "string", description: "Optional category/subcategory slug to scope the search." },
        limit: { type: "number", description: "Max results (default 12)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_service_detail",
    description:
      "Fetch the full callable detail (real endpoints, methods, input/output schemas, exact x402 payment: network/asset/payTo/amount, usage guide) for ONE registry serviceId. Call this before adding or recommending a service so you copy its real endpoints verbatim.",
    input_schema: {
      type: "object",
      properties: { serviceId: { type: "string" } },
      required: ["serviceId"],
    },
  },
  {
    name: "finalize",
    description: "Emit the final result. REQUIRED to end. Either the SKILL.md (mode='skill') or a request for the user to confirm a changed selection (mode='needs_confirmation').",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["skill", "needs_confirmation"] },
        skill: { type: "string", description: "Full SKILL.md file content (frontmatter + body). REQUIRED when mode='skill'." },
        recommendations: {
          type: "array",
          description: "Changes vs the user's selection and any unused selections.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["added", "replaced", "kept", "flagged", "unused"] },
              serviceId: { type: "string" },
              replaces: { type: "string" },
              reason: { type: "string" },
            },
            required: ["action", "reason"],
          },
        },
        message: { type: "string", description: "REQUIRED when mode='needs_confirmation': 1-3 sentences to the user explaining what you found and propose." },
        proposedServiceIds: { type: "array", items: { type: "string" }, description: "Registry serviceIds to ADD to the selection (mode='needs_confirmation')." },
        questions: { type: "array", items: { type: "string" }, description: "Optional clarifying questions for the user (mode='needs_confirmation')." },
      },
      required: ["mode"],
    },
  },
];

export interface Recommendation {
  action: "added" | "replaced" | "kept" | "flagged" | "unused";
  serviceId?: string;
  replaces?: string;
  reason: string;
}

export interface ProposedService {
  id: string;
  name: string;
  pricing: string;
  category: string;
  description: string;
}

export type SkillResult =
  | { mode: "skill"; skill: string; filename: string; name: string; recommendations: Recommendation[] }
  | {
      mode: "needs_confirmation";
      message: string;
      proposed: ProposedService[];
      questions: string[];
      recommendations: Recommendation[];
    };

function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "service-bundle"
  );
}

// Pull the frontmatter `name:` to derive the download filename; fall back to a slug of the goal.
function deriveName(skill: string, goal: string): string {
  const m = skill.match(/^---\s*[\s\S]*?\bname:\s*([^\n]+)/);
  const raw = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  return kebab(raw || goal);
}

export function isBundleBrainConfigured(): boolean {
  return !!(process.env.CLAUDE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

function resolveProposed(ids: string[]): ProposedService[] {
  const out: ProposedService[] = [];
  for (const id of [...new Set(ids)]) {
    const svc = findServiceById(id);
    if (!svc) continue;
    out.push({
      id: svc.id,
      name: svc.name,
      pricing: `${svc.pricing.headline}${svc.pricing.unit ? ` ${svc.pricing.unit}` : ""}`.trim(),
      category: svc.category,
      description: svc.description,
    });
  }
  return out;
}

// Execute one brain tool call (search_registry / get_service_detail). finalize is handled in the loop.
function runTool(name: string, input: Record<string, unknown>): unknown {
  if (name === "search_registry") {
    const query = typeof input.query === "string" ? input.query : "";
    const category = typeof input.category === "string" ? input.category : undefined;
    const limit = typeof input.limit === "number" ? Math.min(Math.max(input.limit, 1), 25) : 12;
    return searchServices({ query, category, limit });
  }
  if (name === "get_service_detail") {
    const id = typeof input.serviceId === "string" ? input.serviceId : "";
    const svc = findServiceById(id);
    if (!svc) return { error: `service '${id}' not found` };
    return serviceToBundle(svc);
  }
  return { error: `unknown tool '${name}'` };
}

export async function generateSkill(input: {
  services: Service[];
  prompt: string;
  confirmed?: boolean;
}): Promise<SkillResult> {
  const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
  });

  const bundleMd = bundleToMarkdown(buildBundle(input.services));
  const confirmedNote = input.confirmed
    ? "\n\nThe user has CONFIRMED this (possibly expanded) selection. Do NOT ask for confirmation again — finalize with mode='skill'."
    : "";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `GOAL:\n${input.prompt}\n\nDecide per the strictness policy whether to stay strict or consult the registry, then call finalize.${confirmedNote}`,
    },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `BUNDLE (the user's selected services):\n\n${bundleMd}`, cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
      // Force termination on the last round; let the model choose (search vs finalize) before that.
      tool_choice: lastRound || input.confirmed ? { type: "tool", name: "finalize" } : { type: "auto" },
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const finalize = toolUses.find((b) => b.name === "finalize");

    if (finalize) {
      const args = (finalize.input ?? {}) as {
        mode?: string;
        skill?: string;
        recommendations?: Recommendation[];
        message?: string;
        proposedServiceIds?: string[];
        questions?: string[];
      };
      const recommendations = Array.isArray(args.recommendations) ? args.recommendations : [];

      if (args.mode === "needs_confirmation" && !input.confirmed) {
        return {
          mode: "needs_confirmation",
          message: args.message?.trim() || "Your selection may not fully cover this goal. Consider adding the services below.",
          proposed: resolveProposed(Array.isArray(args.proposedServiceIds) ? args.proposedServiceIds : []),
          questions: Array.isArray(args.questions) ? args.questions.filter((q) => typeof q === "string") : [],
          recommendations,
        };
      }

      const skill = (args.skill ?? "").trim();
      const name = deriveName(skill, input.prompt);
      return { mode: "skill", skill, filename: `${name}.skill.md`, name, recommendations };
    }

    if (!toolUses.length) {
      // Model answered with plain text instead of a tool — treat any text as the skill (defensive).
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const name = deriveName(text, input.prompt);
      return { mode: "skill", skill: text, filename: `${name}.skill.md`, name, recommendations: [] };
    }

    // Run the requested tools and feed results back.
    const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: JSON.stringify(runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>)),
    }));
    messages.push({ role: "user", content: results });
  }

  // Unreachable in practice (last round forces finalize), but keep the contract total.
  return { mode: "skill", skill: "", filename: "skill.md", name: "skill", recommendations: [] };
}
