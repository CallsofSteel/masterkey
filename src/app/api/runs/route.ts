// Masterkey — POST /api/runs (W5). Session-gated, SHORT route. Creates a RunDoc (concurrent runs per
// user are allowed — the hard one-active-run lock was removed; cost is bounded by spend limits), starts
// the durable engine via the runtime seam (§6), and returns { runId, publicAccessToken } for the browser
// to subscribe. Track B is the Trigger.dev task behind getRuntime(); a failed start fails the run (no
// permanent queued zombie).

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { createRun, patchRun, attachAssetsToRun, setRunStatus } from "@/lib/chat/db";
import { getRuntime } from "@/lib/runtime";
import { getBundleBySlug, getPublicBundleById } from "@/lib/studio/store";
import { compileRecipe, renderRecipeForBrain } from "@/lib/studio/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateRunBody {
  goal?: unknown;
  seedServiceId?: unknown;
  seedBackendProviderId?: unknown;
  parentRunId?: unknown;
  assetUrls?: unknown;
  bundleId?: unknown; // run a SHARED/public bundle by id (All tab); resolves only if the bundle is ready
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: CreateRunBody;
  try {
    body = (await req.json()) as CreateRunBody;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  // Resolve a saved BUNDLE and pre-compile its recipe (spec §6.2) so the durable task stays DB-light.
  //  • bundleId (explicit) → a SHARED/public bundle from the "All" tab. Other users' bundles don't resolve
  //    by slug (own-then-curated), so the client passes the id; only PUBLIC (ready) bundles resolve here.
  //  • else leading "/<slug>" → own-then-curated (a user's own shadows curated; never another user's).
  // Unknown → undefined (the brain treats the goal as a normal prompt).
  let bundleRecipe: string | undefined;
  const bundleId = typeof body.bundleId === "string" ? body.bundleId : undefined;
  if (bundleId) {
    const bundle = await getPublicBundleById(bundleId);
    if (bundle) bundleRecipe = renderRecipeForBrain(compileRecipe(bundle));
  } else {
    const bm = goal.match(/^\/([a-z0-9-]+)/);
    if (bm) {
      const bundle = await getBundleBySlug(bm[1], userId);
      if (bundle) bundleRecipe = renderRecipeForBrain(compileRecipe(bundle));
    }
  }

  const seedServiceId = typeof body.seedServiceId === "string" ? body.seedServiceId : undefined;
  const seedBackendProviderId =
    typeof body.seedBackendProviderId === "string" && seedServiceId ? body.seedBackendProviderId : undefined;
  const parentRunId = typeof body.parentRunId === "string" ? body.parentRunId : undefined;
  const assetUrls = Array.isArray(body.assetUrls)
    ? body.assetUrls.filter((u): u is string => typeof u === "string")
    : [];

  const run = await createRun({
    userId,
    goal,
    ...(seedServiceId ? { seedServiceId } : {}),
    ...(seedBackendProviderId ? { seedBackendProviderId } : {}),
    ...(parentRunId ? { parentRunId } : {}),
  });
  const runId = run._id;

  await attachAssetsToRun(userId, runId, assetUrls);

  // Kick off the durable engine (Track A: no-op fallback; Track B: Trigger.dev task).
  let publicAccessToken = "";
  try {
    const { engineRunId, publicAccessToken: token } = await getRuntime().start({
      runId,
      userId,
      goal,
      ...(seedServiceId ? { seedServiceId } : {}),
      ...(seedBackendProviderId ? { seedBackendProviderId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(bundleRecipe ? { bundleRecipe } : {}),
      assetUrls,
    });
    publicAccessToken = token;
    if (engineRunId) {
      await patchRun(runId, { engineRunId });
    } else if (process.env.TRIGGER_SECRET_KEY) {
      // A durable engine is configured but returned no handle → the trigger didn't take. Do NOT leave
      // the run `queued`: the one-active-run guard would lock the user out permanently (the reaper only
      // sweeps stale `running` runs, never `queued`). Fail it so the slot frees and the UI shows the error.
      await setRunStatus(runId, "failed");
      return NextResponse.json({ runId, error: "run engine did not start" }, { status: 502 });
    }
    // No TRIGGER_SECRET_KEY = Track A fallback by design — leave it queued for a future durable executor.
  } catch {
    // Engine threw — fail the run (free the one-active-run slot; avoid a permanent lockout) and surface it.
    await setRunStatus(runId, "failed");
    return NextResponse.json({ runId, error: "failed to start run" }, { status: 502 });
  }

  return NextResponse.json({ runId, publicAccessToken });
}
