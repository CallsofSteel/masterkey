// Masterkey — POST /api/auth/check
// The client (after CDP embedded-wallet sign-in) sends ONLY its CDP access token. We validate
// it server-side, derive the trusted identity (wallet + email) from the validated endUser
// (never from client input — Appendix R R3), upsert the Mongo user, and set the mk_session cookie.
// See MCP_SPEC.md M1.

import { NextResponse } from "next/server";
import { validateCdpAccessToken, extractIdentity } from "@/lib/cdp";
import { isAllowedEmail, allowedEmailDomains } from "@/lib/auth-domain";
import { upsertUserByWallet } from "@/lib/users";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let accessToken: unknown;
  try {
    accessToken = (await req.json())?.accessToken;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return NextResponse.json({ error: "missing accessToken" }, { status: 400 });
  }

  // Validate server-side; an invalid/expired token throws.
  let endUser;
  try {
    endUser = await validateCdpAccessToken(accessToken);
  } catch {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const { cdpUserId, walletAddress, smartAccountAddress, solanaAddress, email } =
    extractIdentity(endUser);

  // Optional email-domain allowlist (NEXT_PUBLIC_SIGNIN_ALLOWLIST). When no
  // allowlist is configured, isAllowedEmail() returns true for everyone, so forks
  // are not gated. When one IS configured, the email is derived from the validated
  // token (not client input), so this cannot be bypassed via devtools. No matching
  // email → no session is ever minted → the app grants zero access. This is the
  // authoritative enforcement point; the sign-in dialog only mirrors it for UX.
  if (!isAllowedEmail(email)) {
    const domains = allowedEmailDomains().map((d) => `@${d}`).join(", ");
    return NextResponse.json(
      {
        error: "restricted",
        message: `Sign-in is restricted to ${domains} email addresses.`,
      },
      { status: 403 },
    );
  }

  if (!walletAddress) {
    return NextResponse.json({ error: "no EVM wallet on account" }, { status: 400 });
  }

  const user = await upsertUserByWallet({
    walletAddress,
    email,
    cdpUserId,
    smartAccountAddress,
    solanaAddress,
  });
  const token = await signSession(user._id);

  const res = NextResponse.json({ userId: user._id, profile: user.profile });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
