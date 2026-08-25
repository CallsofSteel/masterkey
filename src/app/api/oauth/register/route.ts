// Masterkey — RFC 7591 Dynamic Client Registration. MCP clients (e.g. Claude Code) self-register
// as public PKCE clients (token_endpoint_auth_method: "none"). See MCP_SPEC.md M2 + Appendix R1.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/oauth/store";
import { isAllowedRedirectUri } from "@/lib/oauth/config";

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

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("invalid_client_metadata", "request body must be JSON");
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris.filter((u) => typeof u === "string") as string[])
    : [];
  if (!redirectUris.length) {
    return err("invalid_redirect_uri", "redirect_uris is required");
  }
  for (const u of redirectUris) {
    if (!isAllowedRedirectUri(u)) {
      return err("invalid_redirect_uri", `redirect_uri not allowed: ${u} (https, or http loopback only)`);
    }
  }

  const method =
    body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";

  const { client, clientSecret } = await createClient({
    clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    redirectUris,
    grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as string[]) : undefined,
    responseTypes: Array.isArray(body.response_types) ? (body.response_types as string[]) : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    tokenEndpointAuthMethod: method,
  });

  const response: Record<string, unknown> = {
    client_id: client._id,
    client_id_issued_at: Math.floor(Date.parse(client.createdISO) / 1000),
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
  };
  if (clientSecret) response.client_secret = clientSecret;
  if (client.clientName) response.client_name = client.clientName;
  if (client.scope) response.scope = client.scope;

  return NextResponse.json(response, { status: 201, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
