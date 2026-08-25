// Masterkey — GET/PATCH /api/account (session-gated). The dashboard reads/writes the signed-in
// user's account here instead of localStorage. See MCP_SPEC.md M1.

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import {
  getAccountForUser,
  applyAccountPatch,
  type AccountPatch,
} from "@/lib/account-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const account = await getAccountForUser(userId);
  if (!account) return NextResponse.json({ error: "user not found" }, { status: 404 });
  return NextResponse.json(account);
}

export async function PATCH(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  let patch: AccountPatch;
  try {
    patch = (await req.json()) as AccountPatch;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  await applyAccountPatch(userId, patch ?? {});
  const account = await getAccountForUser(userId);
  return NextResponse.json(account);
}
