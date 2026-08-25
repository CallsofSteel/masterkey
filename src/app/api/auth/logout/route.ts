// Masterkey — POST /api/auth/logout. Clears the first-party session cookie. (The client also
// calls CDP signOut() via useSignOut.) See MCP_SPEC.md M1.

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
