// Masterkey — the brain's MCP tool layer (server-only). Defines the 4 Anthropic tools the brain may
// call and executes them against our MCP over HTTP (the ONE enforcement path — same M5 spend + M7
// idempotency as the agent side). The first-party bearer token is minted at run start (first-party-
// token.ts) and passed in. `idempotencyKey` is HARNESS-injected for run_service (the LLM never sees
// it — see idempotency-key.ts / seq derivation in brain.ts); the LLM tool schema omits it.

import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MCP_TOOL_NAMES = ["search_services", "get_service", "run_service", "get_result", "get_email_inbox"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

// A single MCP tool call may run a slow synchronous provider; cap just under the /mcp route's 300s.
const MCP_CALL_TIMEOUT_MS = 290_000;

/**
 * The 4 tools exposed to the Messages API. cache_control on the LAST tool caches the whole tool
 * prefix (W4 / W-S M3). Schemas mirror the MCP tools but OMIT idempotencyKey (harness-injected).
 */
export const MCP_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_services",
    description:
      "Search Masterkey's catalog of paid services (AI media, LLMs, voice, data, search, comms, commerce, infra). Returns a ranked, compact list of services with their serviceId, name, category, and price. Use this first to find the right service for a step.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need, e.g. 'generate an image' or 'send email'." },
        limit: { type: "number", description: "Max results (default ~20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_service",
    description:
      "Get full detail for one service by serviceId: its operations, input/output schema, modality, and price. Call before run_service when you need the exact input shape.",
    input_schema: {
      type: "object",
      properties: { serviceId: { type: "string", description: "The service's id from search_services." } },
      required: ["serviceId"],
    },
  },
  {
    name: "run_service",
    description:
      "Execute a service and get its result. The platform pays for the call on the user's behalf. For an api-kind service, pass `operation`. Slow services return a job that is polled for you. Returns the result (image/video/audio URL, text, or JSON).",
    input_schema: {
      type: "object",
      properties: {
        serviceId: { type: "string" },
        operation: { type: "string", description: "Operation name (api-kind services only)." },
        backendProviderId: {
          type: "string",
          description:
            "Optional. Pin a specific provider/endpoint for this service (the selector key from the seed instruction or get_service). Omit to use the cheapest payable backend.",
        },
        input: { type: "object", description: "The inputs this service requires (see get_service)." },
        model: { type: "string", description: "Optional model selector for multi-model gateways." },
      },
      required: ["serviceId", "input"],
    },
  },
  {
    name: "get_result",
    description: "Retrieve the result of a previously-submitted async job by jobId. Usually unnecessary — the runtime polls jobs for you.",
    input_schema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "get_email_inbox",
    description:
      "Get the user's managed email inbox address (created once, reused across runs). Call this BEFORE sending email, then pass the returned address as the inbox to send FROM. Never create an email inbox yourself.",
    input_schema: { type: "object", properties: {} },
    cache_control: { type: "ephemeral" },
  },
];

export interface McpToolResult {
  /** The structured payload (RunResultEnvelope for run_service; results list for search, etc.). */
  structured: unknown;
  /** Whether the MCP flagged the call as an error (still returned to the LLM as a tool_result). */
  isError: boolean;
}

/** Connect an MCP client to our /mcp over HTTP with the first-party bearer token. Caller closes it. */
export async function connectMcp(origin: string, token: string): Promise<Client> {
  const client = new Client({ name: "masterkey-web-brain", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin.replace(/\/+$/, "")}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/**
 * Call one MCP tool. For run_service, `idempotencyKey` (harness-computed) is merged into the args so
 * a crash-replay dedupes and an intentional duplicate (seq+1) pays again. Returns the structured
 * payload + isError for feeding back as a tool_result.
 */
export async function callMcpTool(
  client: Client,
  name: McpToolName,
  args: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<McpToolResult> {
  const argsWithKey =
    name === "run_service" && idempotencyKey ? { ...args, idempotencyKey } : args;
  // Match the /mcp route's maxDuration (300s): a slow SYNCHRONOUS provider (e.g. a research-grade model)
  // can take minutes. The MCP SDK's default callTool timeout is only 60s — without this override a slow
  // run_service aborts with "-32001 Request timed out" and fails the run. (Async jobs use get_result.)
  const res = await client.callTool({ name, arguments: argsWithKey }, undefined, { timeout: MCP_CALL_TIMEOUT_MS });
  const structured = res.structuredContent ?? res.content ?? null;
  return { structured, isError: res.isError === true };
}
