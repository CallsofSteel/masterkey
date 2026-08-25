// Masterkey — first-party session (server-only). After the CDP access token is validated
// server-side, we mint our own signed httpOnly cookie (mk_session) carrying the userId, so
// server components + route handlers (and the OAuth /authorize consent screen, M2) can identify
// the resource owner. See MCP_SPEC.md M1 + Appendix R R3.
//
// DESIGN NOTE (intentional): mk_session is the AUTHORITATIVE app session and is deliberately
// DECOUPLED from CDP's own session lifecycle — it is not refreshed against, nor invalidated by,
// CDP token expiry/sign-out. It stands alone for up to SESSION_MAX_AGE. This is a chosen tradeoff,
// not an oversight. Consequence: the app session can outlive the CDP session. When value-bearing
// actions (spend, card linking) come online, the recommended pattern is to re-validate a FRESH CDP
// access token at action time, rather than coupling this cookie to CDP's lifecycle.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getUser } from "@/lib/users";
import type { UserDoc } from "@/lib/mcp/types";

export const SESSION_COOKIE = "mk_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days — standalone app session (see DESIGN NOTE above)

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return new TextEncoder().encode(s);
}

/** Sign a session token (JWT { sub: userId }). */
export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secret());
}

/** Verify a session token → userId, or null if invalid/expired. */
export async function verifySession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Cookie attributes for Set-Cookie (used on the auth response). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/** Read + verify the session cookie → userId, or null. (Server components / route handlers.) */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/** The full user doc for the current session, or null. */
export async function getSessionUser(): Promise<UserDoc | null> {
  const id = await getSessionUserId();
  if (!id) return null;
  return getUser(id);
}
