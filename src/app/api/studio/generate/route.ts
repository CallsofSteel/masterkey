// Masterkey — POST /api/studio/generate (spec §12.1). The quick bar's "Generate": given selected serviceIds
// + a goal, drafts a runnable bundle GRAPH (reusing the build-assist brain) and SAVES it to the library, so
// the result is a real bundle (Run via "/", open in the builder, export) — not just a SKILL.md clipboard.
// Auth-gated (spends the platform Anthropic key), rate-limited by proxy.ts. Preserves the ask-first flow:
// a too-vague goal returns { mode: "needs_confirmation", message } instead of saving.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { isAssistConfigured } from "@/lib/studio/assist";
import { generateBundleRecipe } from "@/lib/studio/generate";
import { saveBundle, mintUniqueSlug } from "@/lib/studio/store";
import { deriveSlug, bundleToApi } from "@/lib/studio/serialize";
import type { BundleDoc } from "@/lib/studio/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SERVICES = 40;
const MAX_PROMPT = 4000;

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (!isAssistConfigured()) {
    return NextResponse.json({ error: "bundle generation is not configured on this deployment" }, { status: 503 });
  }

  let body: { serviceIds?: unknown; prompt?: unknown };
  try {
    body = (await req.json()) as { serviceIds?: unknown; prompt?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const serviceIds = Array.isArray(body.serviceIds)
    ? [...new Set(body.serviceIds.filter((x): x is string => typeof x === "string"))].slice(0, MAX_SERVICES)
    : [];
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return NextResponse.json({ error: "describe what the bundle should do" }, { status: 400 });

  try {
    const result = await generateBundleRecipe({ serviceIds, prompt, userId });
    if (result.mode === "needs_confirmation") {
      return NextResponse.json({ mode: "needs_confirmation", message: result.message });
    }

    // Save the drafted graph as a `quick`-source draft bundle (unique per-owner slug).
    const slug = await mintUniqueSlug(userId, deriveSlug(result.name));
    const doc: BundleDoc = {
      _id: "",
      slug,
      name: result.name,
      description: result.description,
      ownerUserId: userId,
      source: "quick",
      graph: result.graph,
      inputs: [],
      status: "draft",
      createdISO: "",
      updatedISO: "",
    };
    const saved = await saveBundle(doc);
    return NextResponse.json({ mode: "bundle", bundle: bundleToApi(saved, false), reply: result.reply });
  } catch (err) {
    console.error("[studio/generate] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "bundle generation failed — try again" }, { status: 502 });
  }
}
