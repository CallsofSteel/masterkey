// Masterkey — OAuth 2.1 token endpoint. authorization_code (PKCE) + refresh_token grants.
// Issues opaque, audience-bound tokens (Appendix R1). See MCP_SPEC.md M2.

import { NextResponse } from "next/server";
import { verifyPkceS256 } from "@/lib/oauth/crypto";
import {
  getClient,
  verifyClientSecret,
  consumeAuthCode,
  issueTokens,
  rotateRefreshToken,
  touchConnection,
} from "@/lib/oauth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function err(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers: CORS });
}

function tokenResponse(t: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return NextResponse.json(
    {
      access_token: t.accessToken,
      token_type: "Bearer",
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: t.scope,
    },
    { headers: { ...CORS, "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err("invalid_request", "expected application/x-www-form-urlencoded body");
  }
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };

  const grantType = get("grant_type");
  const clientId = get("client_id");
  const clientSecret = get("client_secret");

  if (!clientId) return err("invalid_client", "client_id is required", 401);
  const client = await getClient(clientId);
  if (!client) return err("invalid_client", "unknown client", 401);
  if (!verifyClientSecret(client, clientSecret)) {
    return err("invalid_client", "client authentication failed", 401);
  }

  if (grantType === "authorization_code") {
    const code = get("code");
    const redirectUri = get("redirect_uri");
    const codeVerifier = get("code_verifier");
    if (!code || !redirectUri || !codeVerifier) {
      return err("invalid_request", "code, redirect_uri, code_verifier are required");
    }
    const authCode = await consumeAuthCode(code);
    if (!authCode) return err("invalid_grant", "authorization code invalid or expired");
    if (authCode.clientId !== clientId) return err("invalid_grant", "code was issued to another client");
    if (authCode.redirectUri !== redirectUri) return err("invalid_grant", "redirect_uri mismatch");
    if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
      return err("invalid_grant", "PKCE verification failed");
    }
    const issued = await issueTokens({
      userId: authCode.userId,
      clientId,
      connectionId: authCode.connectionId,
      scope: authCode.scope,
      audience: authCode.audience,
    });
    await touchConnection(authCode.connectionId);
    return tokenResponse({ ...issued, scope: authCode.scope });
  }

  if (grantType === "refresh_token") {
    const refreshToken = get("refresh_token");
    if (!refreshToken) return err("invalid_request", "refresh_token is required");
    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) return err("invalid_grant", "refresh token invalid, revoked, or expired");
    return tokenResponse(rotated);
  }

  return err("unsupported_grant_type", `unsupported grant_type: ${grantType ?? "(none)"}`);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
