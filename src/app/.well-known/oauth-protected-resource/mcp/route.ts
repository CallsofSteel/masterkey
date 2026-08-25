// Masterkey — RFC 9728 Protected Resource Metadata for the MCP resource at /mcp. The path is
// suffixed with the resource path (/mcp) per RFC 9728 + the MCP Authorization spec (Appendix R1),
// so clients resolving the WWW-Authenticate resource_metadata URL find it here. See MCP_SPEC.md M3.

import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";
import { ISSUER, MCP_RESOURCE_URL } from "@/lib/oauth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = protectedResourceHandler({
  authServerUrls: [ISSUER],
  resourceUrl: MCP_RESOURCE_URL,
});

export { handler as GET };
export const OPTIONS = metadataCorsOptionsRequestHandler();
