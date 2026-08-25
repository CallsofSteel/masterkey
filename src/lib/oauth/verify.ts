// Masterkey — MCP bearer-token verification (server-only). Validates our opaque access tokens for
// the Resource Server (the /mcp endpoint). Enforces RFC 8707 audience binding (Appendix R1).
// See MCP_SPEC.md M3.

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { findValidToken, touchConnection } from "./store";
import { MCP_RESOURCE_URL } from "./config";

/** withMcpAuth verifyToken: validate a bearer token → AuthInfo, or undefined to reject (401). */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  const tok = await findValidToken(bearerToken, "access");
  if (!tok) return undefined;

  // RFC 8707: the token must be audience-bound to THIS resource (R1).
  if (tok.audience !== MCP_RESOURCE_URL) return undefined;

  void touchConnection(tok.connectionId); // best-effort; don't block the request

  return {
    token: bearerToken,
    clientId: tok.clientId,
    scopes: tok.scope.split(/\s+/).filter(Boolean),
    expiresAt: Math.floor(tok.expiresAt.getTime() / 1000),
    extra: { userId: tok.userId, connectionId: tok.connectionId },
  };
}
