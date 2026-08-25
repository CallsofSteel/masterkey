// Masterkey — OAuth 2.1 Authorization Server config (server-only). Masterkey is both the AS and
// the Resource Server (the MCP at /mcp). See MCP_SPEC.md M2 + Appendix R1 (issuer exactness,
// absolute endpoint URLs, RFC 8707 resource/audience = the MCP resourceUrl).

// Issuer must be stable + exact (no trailing slash) and equal across AS metadata + PRM.
export const ISSUER = (process.env.OAUTH_ISSUER || "http://localhost:3000").replace(/\/+$/, "");

// The protected resource (MCP). Tokens are audience-bound to this (RFC 8707).
export const MCP_RESOURCE_URL = `${ISSUER}/mcp`;

// OAuth protocol scopes (what tools). Spend buckets are separate — stored on ConnectionDoc.scopes.
export const SCOPES = ["mcp:read", "mcp:run"] as const;
export type OAuthScope = (typeof SCOPES)[number];
export const DEFAULT_SCOPE = "mcp:read mcp:run";

export function normalizeScope(scope: string | null | undefined): string {
  const req = (scope ?? "").split(/\s+/).filter(Boolean);
  const granted = req.filter((s): s is OAuthScope => (SCOPES as readonly string[]).includes(s));
  return (granted.length ? granted : SCOPES).join(" ");
}

export const ENDPOINTS = {
  // The authorization endpoint is a PAGE (renders the consent screen), not an API route.
  authorization: `${ISSUER}/oauth/authorize`,
  token: `${ISSUER}/api/oauth/token`,
  registration: `${ISSUER}/api/oauth/register`,
};

export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const AUTH_CODE_TTL_SEC = 60; // 60 seconds

const ALLOWED_NATIVE_REDIRECT_URIS = new Set([
  "cursor://anysphere.cursor-mcp/oauth/callback",
]);

/** RFC 8414 Authorization Server Metadata. */
export function authServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: ENDPOINTS.authorization,
    token_endpoint: ENDPOINTS.token,
    registration_endpoint: ENDPOINTS.registration,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  };
}

/** HTTPS, loopback HTTP, and explicitly trusted native-app redirect URIs. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  if (ALLOWED_NATIVE_REDIRECT_URIS.has(uri)) return true;
  return false;
}
