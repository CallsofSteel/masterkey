// Masterkey — GET /api/library (W10). Session-gated. Returns the signed-in user's recent runs +
// saved output assets for the library gallery.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { listRunsForUser, listOutputAssetsForUser } from "@/lib/chat/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const [runs, outputs] = await Promise.all([listRunsForUser(userId), listOutputAssetsForUser(userId)]);
  return NextResponse.json({ runs, outputs });
}
