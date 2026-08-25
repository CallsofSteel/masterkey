// Masterkey — POST /api/runs/[id]/approve (W6). The ONLY completion path for a send-approval
// waitpoint. Ownership-checked; the waitpoint tokenId is read SERVER-ONLY from the RunDoc (never the
// browser — W-S C5). Idempotent: a double-click / replay against an already-resolved waitpoint is a
// no-op 200 (v2.2). Body: { decision: { action: "approve"|"edit"|"regenerate"|"reject", payload? } }.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { getRunForUser } from "@/lib/chat/db";
import { getRuntime } from "@/lib/runtime";
import type { ApprovalDecision } from "@/lib/runtime/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set(["approve", "edit", "regenerate", "reject"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const run = await getRunForUser(id, userId);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { decision?: { action?: string; payload?: unknown } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const decision = body.decision;
  if (!decision || typeof decision.action !== "string" || !ACTIONS.has(decision.action)) {
    return NextResponse.json({ error: "invalid decision" }, { status: 400 });
  }

  // Idempotent state guard: only complete if there is genuinely an open waitpoint for this run.
  if (run.status !== "awaiting_approval" || !run.pendingApproval?.tokenId) {
    return NextResponse.json({ ok: true, noop: true });
  }

  try {
    await getRuntime().resumeApproval(id, run.pendingApproval.tokenId, decision as ApprovalDecision);
  } catch {
    return NextResponse.json({ error: "could not complete approval" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
