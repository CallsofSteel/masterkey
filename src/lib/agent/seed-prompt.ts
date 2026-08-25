// Masterkey — the run's system persona + seed message (W4). Server-only (reads the registry to
// surface a seed service's operations). The brain feeds RUNNER_SYSTEM_PROMPT as the system block and
// buildSeedMessage(...) as the first user turn. Reuses catalog intent but is agent-facing, not display.

import { findServiceById } from "@/lib/registry";
import { getBundle } from "@/lib/bundles";
import { compileRecipe, renderRecipeForBrain } from "@/lib/studio/compile";
import type { BundleDoc } from "@/lib/studio/types";
import { backendKey, indexForBackendKey } from "@/data/backend-key";
import type { Service, Backend } from "@/data/types";

/** Pick the backend the run should use: the user-selected one (by selector key), else the headline-priced
 *  one, else the first priced backend, else the first. Mirrors the catalog's primaryBackend default. */
function chooseBackend(svc: Service, seedBackendProviderId?: string): { backend: Backend | null; key: string | null } {
  const backends = svc.backends ?? [];
  if (!backends.length) return { backend: null, key: null };
  const entries = backends.map((b) => ({ providerId: b.providerId, url: b.url }));
  if (seedBackendProviderId) {
    const i = indexForBackendKey(entries, seedBackendProviderId);
    if (i >= 0) return { backend: backends[i], key: backendKey(entries, i) };
  }
  let i = svc.pricing.amount != null ? backends.findIndex((b) => b.price?.amount === svc.pricing.amount) : -1;
  if (i < 0) i = backends.findIndex((b) => b.price?.amount != null);
  if (i < 0) i = 0;
  return { backend: backends[i], key: backendKey(entries, i) };
}

/**
 * The Masterkey runner persona. Money is invisible (the platform pays — never mention
 * wallets/x402/USDC). Outward/irreversible actions STOP for approval. Tools are Masterkey-only.
 */
export const RUNNER_SYSTEM_PROMPT = `You are Masterkey's autonomous runner. Fulfill the user's goal end-to-end using ONLY the Masterkey tools provided (search_services, get_service, run_service, get_result). You have no other tools — no shell, no file access, no arbitrary web.

How you work:
- Plan, then act. Discover the right services with search_services, inspect them with get_service, and execute them with run_service. Feed each result into the next step. Recover from failures (try an alternative service or retry once) rather than giving up.
- If the user pinned a seed service, prefer it first, then chain other Masterkey services as needed.
- Choosing a service: search_services already ranks the best options first. Prefer "active" services with a known price; treat "needs-review" or "Varies"-priced ones as fallbacks. Don't over-shop — pick a strong candidate, inspect it once with get_service, and run it; only try another if it fails. If a service returns a still-processing/empty result with no usable output, switch to a different provider rather than re-running the same one.
- A DEAD endpoint, not a payload bug: if a call fails with \`provider_error\` (e.g. "provider returned 404"), \`service_not_found\`, or \`no_payable_target\`, that endpoint is UNAVAILABLE — the registry entry is stale/moved. Do NOT keep re-calling the same serviceId with tweaked inputs (a 404 will stay a 404). Retry the exact same call AT MOST once, then IMMEDIATELY \`search_services\` for a different service with the same capability and use that instead. When a step must run over many items (a loop), first prove the chosen service works on ONE item; only fan out once it succeeds — so a dead endpoint costs one failed call, not a dozen.
- EMPTY results STILL COST MONEY — adapt, don't repeat: a paid call that returns an empty set (e.g. \`{"people":[]}\`, \`{"results":[]}\`, \`{"data":[]}\`) usually charged you IN FULL even though it found nothing. This is almost never "no data exists" — it's a too-narrow or wrong-shaped query (e.g. filtering people-search by an exact job TITLE like "Developer Relations" instead of a SENIORITY level, or an over-specific value the provider's vocabulary doesn't match). When you get an empty paid result: (1) do NOT immediately fire the same query shape at the next item; (2) BROADEN or re-shape the query ONCE on the SAME item — loosen/drop the narrowest filter, switch a title filter to a seniority/keyword filter, use the provider's documented vocabulary from its usage guide; (3) if it's still empty, SWITCH to a different provider for that capability. NEVER fan the same empty-returning query shape across many items (that's how you burn dollars on nothing) — prove a query shape actually returns rows on ONE item BEFORE repeating it across the rest.
- Picking a backend within a service: services may list several backends (the official provider plus third-party gateways). Just call run_service with the serviceId and DON'T pass backendProviderId — it defaults to the recommended/first-party backend (the official provider). Only pin backendProviderId when you deliberately want a specific gateway.
- Long jobs (video, large images) return a pending job — the runtime polls it for you; just call run_service and use the result when it arrives.

Do text work YOURSELF (don't pay for an LLM):
- You are a strong language model. Any step that is writing, summarizing, rewriting, extracting, classifying, scoring/ranking, deciding, translating, or formatting — DO IT YOURSELF, directly in your reply. NEVER call run_service on a chat-completion / general LLM text service (e.g. "chat completions", GPT/DeepSeek/Llama text endpoints) to draft an email, write a summary, or generate copy — that is a wasteful paid call for something you already do better in-context, and it's a mistake.
- Use run_service ONLY for capabilities you genuinely lack: live data (web search, scraping, social, people/email enrichment), media generation/editing (image, video, audio/TTS, transcription), sending/publishing, payments, sandboxes, and similar. If a bundle step says "write/draft/summarize …", that's YOUR work — just produce the text.

Money is invisible:
- The Masterkey platform pays for every service call on the user's behalf. NEVER mention wallets, crypto, USDC, x402, payments, or per-call prices to the user. Speak only about the work and its results.

Outward actions (this is a hard rule):
- For an outward/irreversible action — sending an email/SMS/message, placing a call, mailing something, making a purchase, or publishing publicly — CALL run_service for it exactly as you would any other service, with the COMPLETE final content (recipients, subject, body, etc.). The Masterkey platform AUTOMATICALLY pauses and shows the user your exact draft for approval BEFORE anything is sent — you do not need to (and must not) handle approval yourself.
- Do NOT stop and ask for approval in text, and do NOT just describe the draft and end your turn — that sends nothing. To actually send, you MUST call run_service; the platform gates it. After it returns, report the outcome.
- Generating, fetching, scraping, hosting, and analyzing are autonomous (no pause). Only the outward actions above are gated — and the gating is automatic, so just make the call.

Sending email:
- The user has ONE managed email inbox that is reused across runs. To send email, FIRST call get_email_inbox to get their inbox address (it's created once automatically if they don't have one) — then call run_service on an email service (e.g. agentmail) "Send message" with inbox_id set to that address. NEVER create an email inbox yourself (that recreates a costly inbox every time); always get_email_inbox first.

Finish by clearly summarizing what you did and surfacing the outputs.`;

/** Build the first user message: the goal + any attached asset URLs + (optional) seed-service guidance.
 *  When seeded from a catalog service we INLINE what the brain needs to call it correctly (the chosen
 *  provider/endpoint, price, input schema, and the tested usage guide) so it doesn't have to rediscover
 *  it — and so the user's provider choice is carried through, not just the goal. */
export function buildSeedMessage(input: {
  goal: string;
  seedServiceId?: string;
  seedBackendProviderId?: string;
  assetUrls?: string[];
  /** Pre-compiled bundle recipe text (renderRecipeForBrain), threaded from run-creation for a leading
   *  "/<slug>" — handles BOTH curated + user bundles, ownership-checked at /api/runs (spec §6.2/§6.3).
   *  When present it REPLACES the curated-file lookup below. */
  bundleRecipe?: string;
}): string {
  const lines: string[] = [input.goal.trim()];

  if (input.assetUrls?.length) {
    lines.push("", "Attached files (pass these URLs to services that accept them):");
    for (const url of input.assetUrls) lines.push(`- ${url}`);
  }

  if (input.seedServiceId) {
    const svc = findServiceById(input.seedServiceId);
    if (svc) {
      lines.push(
        "",
        `Start with the "${svc.name}" service (serviceId: ${svc.id}); use other Masterkey services as needed to complete the goal.`,
      );

      // The provider/endpoint the user picked (or the default cheapest) — pin it on run_service.
      const { backend, key } = chooseBackend(svc, input.seedBackendProviderId);
      if (backend && key) {
        const price = backend.price?.display ? ` (≈ ${backend.price.display})` : "";
        lines.push(
          `Use the ${backend.provider} provider for it — pass backendProviderId: "${key}" to run_service${price}.`,
        );
        const schema = backend.inputSchema ?? svc.backends?.find((b) => b.inputSchema)?.inputSchema;
        if (schema && Object.keys(schema).length) {
          lines.push(`Its input schema: ${JSON.stringify(schema)}`);
        }
      }

      if (svc.kind === "api" && svc.operations.length) {
        lines.push(`Its operations: ${svc.operations.map((o) => o.name).join(", ")}.`);
      }

      // Tested usage guidance from Registry QA (the registry's moat) — quirks first, then the call shape.
      if (svc.usage?.guide) lines.push(`How to use: ${svc.usage.guide}`);
      if (svc.usage?.callShape) lines.push(`Call shape: ${svc.usage.callShape}`);
      if (svc.usage?.quirks?.length) {
        lines.push("Notes:");
        for (const q of svc.usage.quirks) lines.push(`- ${q}`);
      }
    }
  }

  // §3.2: the user can "@<serviceId>" services in the goal text to pin them. Resolve each to a real
  // service (false positives like emails won't resolve) and tell the agent to prefer them.
  const mentionedIds = [...new Set((input.goal.match(/@([a-z0-9][a-z0-9-]*)/g) ?? []).map((m) => m.slice(1)))].filter(
    (id) => id !== input.seedServiceId,
  );
  const mentioned = mentionedIds.map((id) => findServiceById(id)).filter((s): s is Service => !!s);
  if (mentioned.length) {
    lines.push("", "The user referenced these Masterkey services with @ — prefer them for the matching parts of the goal:");
    for (const s of mentioned) {
      const price = s.pricing?.headline ? ` — ${s.pricing.headline}${s.pricing.unit ? ` ${s.pricing.unit}` : ""}` : "";
      lines.push(`- ${s.name} (serviceId: ${s.id})${s.category ? ` · ${s.category}` : ""}${price}`);
    }
  }

  // A leading "/<slug>" runs a BUNDLE — a fixed multi-step recipe. Prefer the pre-compiled recipe threaded
  // from run-creation (§6.2): it covers BOTH curated + user bundles (ownership-checked at /api/runs) and
  // already renders branches/loops (§1.2). Fall back to the curated FILE loader only when no precompiled
  // recipe was provided (legacy/edge callers) — user bundles never resolve here (Mongo-only), avoiding leaks.
  if (input.bundleRecipe) {
    lines.push("", input.bundleRecipe);
    return lines.join("\n");
  }
  const bm = input.goal.match(/^\/([a-z0-9-]+)/);
  const bundle = bm ? getBundle(bm[1]) : null;
  if (bundle?.steps?.length) {
    lines.push(
      "",
      `Run the "${bundle.name}" bundle — a fixed recipe (${bundle.description}). Do the steps IN ORDER, feeding each step's output into the next:`,
    );
    bundle.steps.forEach((s, i) => {
      const svc = s.serviceId ? ` → call run_service with serviceId "${s.serviceId}" for this step` : "";
      lines.push(`${i + 1}. ${s.label} — ${s.instruction}${svc}`);
    });
    lines.push(
      "Use each step's pinned serviceId DIRECTLY (no need to search_services first); only pick an alternative if a pinned service actually fails. Treat the rest of the user's message as the bundle's input.",
    );
  } else if (bundle?.graph) {
    // Graph-based curated bundle (branches/loops) → render via the drift-free compiler, same as §6.2.
    const doc: BundleDoc = {
      _id: `curated_${bundle.slug}`, slug: bundle.slug, name: bundle.name, description: bundle.description,
      trigger: bundle.trigger, ownerUserId: null, source: "curated", graph: bundle.graph, inputs: bundle.inputs,
      status: "ready", createdISO: "", updatedISO: "",
    };
    lines.push("", renderRecipeForBrain(compileRecipe(doc)));
  }

  return lines.join("\n");
}
