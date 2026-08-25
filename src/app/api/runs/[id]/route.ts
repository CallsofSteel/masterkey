// Masterkey — GET /api/runs/[id] (W5). Session-gated, ownership-checked. Returns { run, steps } —
// the persisted transcript that the run view replays from (Mongo = source of truth). The polling
// useRunSubscription (§6 fallback) calls this; the Trigger Realtime impl (Track B) uses it for the
// initial replay too. Returns 404 (not 403) on a run the user doesn't own (no existence disclosure).

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getSessionForUser, redactRunForClient, sessionCostUsd, sessionPendingCostUsd } from "@/lib/chat/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const session = await getSessionForUser(id, userId);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Settled total + the not-yet-reconciled remainder, so the header can show "settling" instead of a
  // silently low number while the reconciler works (RUN_RELIABILITY_SPEC 1.4/2.5).
  const [cost, pending] = await Promise.all([sessionCostUsd(session.latest), sessionPendingCostUsd(session.latest)]);
  return NextResponse.json({
    run: { ...redactRunForClient(session.latest), sessionCostUsd: cost, pendingCostUsd: pending }, // LATEST run drives status + reply target
    segments: session.segments.map((s) => ({ run: redactRunForClient(s.run), steps: s.steps })),
  });
}
