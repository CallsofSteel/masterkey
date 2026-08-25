// Masterkey — MCP Resource Server (Streamable HTTP at /mcp; SSE at /sse). mcp-handler derives
// these from basePath "/". Auth via withMcpAuth → our opaque-token verifier (audience-bound).
// Tools are registered here; M6 adds the full surface. See MCP_SPEC.md M3 + Appendix R1.
//
// NOTE: this is a root-level [transport] route. Static routes (/dashboard, /oauth, /api,
// /.well-known, "/") take priority; only /mcp, /sse, /message resolve here.

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerDiscoveryTools } from "@/lib/mcp/tools";
import { registerRunServiceTool } from "@/lib/mcp/run";
import { verifyMcpToken } from "@/lib/oauth/verify";
import { ISSUER } from "@/lib/oauth/config";
import { isMcpAppsEnabled } from "@/lib/mcp/apps/flag";
import { registerRunViewerResource } from "@/lib/mcp/apps/resource";

export const runtime = "nodejs";
// Image/video generation can take a while; allow up to 300s (Vercel caps to the plan max — 60s on
// Hobby, up to 300s on Pro). The MCP client may still impose its own tool-call timeout.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  (server) => {
    // M6 discovery tools (mcp:read): list_categories, search_services, get_service, estimate_cost,
    // get_limits, get_usage.
    registerDiscoveryTools(server);
    // M7 run_service (mcp:run): enforce → pay (Sponge) → ledger → return.
    registerRunServiceTool(server);
    // MCP Apps (MCP_APPS_SPEC §5): the ui:// run-viewer resource. Flag-gated + off by default, so
    // when MASTERKEY_MCP_APPS!=1 nothing is registered and behavior is byte-identical to before.
    if (isMcpAppsEnabled()) registerRunViewerResource(server);
  },
  {
    // `name` is the stable protocol IDENTIFIER — keep it lowercase and never rename it:
    // clients key/dedup connections on it, and it matches `ui://masterkey/...` and the
    // `claude mcp add … masterkey` alias. `title` is the human-readable display name
    // (MCP BaseMetadata), which is what hosts should surface in their connector UI.
    // mcp-handler types serverInfo as {name, version}, but it passes the object VERBATIM to
    // `new McpServer(...)`, whose Implementation type does accept `title` (SDK 1.26 BaseMetadata).
    // The cast satisfies the narrow wrapper type without dropping the field.
    serverInfo: { name: "masterkey", title: "Masterkey", version: "0.1.0" } as {
      name: string;
      version: string;
    },
    // `resources` is advertised only when MCP Apps is on (we register a resource only then).
    capabilities: isMcpAppsEnabled() ? { tools: {}, resources: {} } : { tools: {} },
  },
  { basePath: "/", maxDuration: 300, verboseLogs: false },
);

const authHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["mcp:read"],
  // resourceMetadataPath is appended to the ORIGIN (resourceUrl) to form the resource_metadata
  // URL → ${ISSUER}/.well-known/oauth-protected-resource/mcp (RFC 9728, R1).
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  resourceUrl: ISSUER,
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
