// Masterkey — POST /api/bundle/skill. Sign-in-gated (it spends the platform Anthropic key): given
// selected serviceIds + a goal prompt, loads full registry detail for the selected services and has the
// Bundle Composer brain author a Claude Agent SKILL.md (strict to the selection). Returns { skill,
// filename, name }. Rate-limited by proxy.ts.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { findServiceById } from "@/lib/registry";
import { generateSkill, isBundleBrainConfigured } from "@/lib/bundle/skill";
import type { Service } from "@/data/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SERVICES = 40;
const MAX_PROMPT = 4000;

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (!isBundleBrainConfigured()) {
    return NextResponse.json({ error: "skill generation is not configured on this deployment" }, { status: 503 });
  }

  let body: { serviceIds?: unknown; prompt?: unknown; confirmed?: unknown };
  try {
    body = (await req.json()) as { serviceIds?: unknown; prompt?: unknown; confirmed?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const ids = Array.isArray(body.serviceIds)
    ? [...new Set(body.serviceIds.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x)))]
    : [];
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT) : "";
  const confirmed = body.confirmed === true;

  if (!ids.length) return NextResponse.json({ error: "select at least one service" }, { status: 400 });
  if (ids.length > MAX_SERVICES) return NextResponse.json({ error: `too many services (max ${MAX_SERVICES})` }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: "describe how the services should work together" }, { status: 400 });

  const services = ids.map(findServiceById).filter((s): s is Service => !!s);
  if (!services.length) return NextResponse.json({ error: "no matching services" }, { status: 404 });

  try {
    const result = await generateSkill({ services, prompt, confirmed });
    if (result.mode === "skill" && !result.skill) {
      return NextResponse.json({ error: "the brain returned no content — try again" }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[bundle/skill] generation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "skill generation failed — try again" }, { status: 502 });
  }
}
