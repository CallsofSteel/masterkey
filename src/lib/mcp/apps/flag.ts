// Masterkey × MCP Apps — feature flag (MCP_APPS_SPEC.md §6 rollout / §8 prereq #6).
//
// OFF BY DEFAULT. When unset (the prod default today), the MCP server must behave BYTE-IDENTICALLY
// to before MCP Apps existed: no ui:// resource registered, no `_meta.ui.resourceUri` on any tool, and
// no gate inversion in `toToolResult`. MCP Apps is a draft-stage spec, so this is the outer
// kill-switch wrapping every Apps code path.
//
// Read at call time (not module-init) so a serverless instance picks up the env without a cold-start
// race, and so tests can toggle it.
export function isMcpAppsEnabled(): boolean {
  return process.env.MASTERKEY_MCP_APPS === "1";
}
