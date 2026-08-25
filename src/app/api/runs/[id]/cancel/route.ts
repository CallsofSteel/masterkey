// Masterkey — POST /api/runs/[id]/cancel (W6 / W-S C7). Ownership-checked. Terminates the engine run
// (if any), marks the RunDoc canceled (terminal → frees the one-active-run slot), and clears any open
// waitpoint. Surfaced by the 409 on POST /api/runs so a user who walked away from an approval isn't
// locked out for the 24h waitpoint TTL.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getRunForUser, clearPendingApproval, isTerminal } from "@/lib/chat/db";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const run = await getRunForUser(id, userId);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (isTerminal(run.status)) return NextResponse.json({ ok: true, noop: true });

  if (run.engineRunId) {
    try {
      await getRuntime().cancel(run.engineRunId);
    } catch {
      // best-effort — still mark canceled below so the slot is freed
    }
  }
  await clearPendingApproval(id, "canceled");
  return NextResponse.json({ ok: true });
}
