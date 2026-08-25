// Masterkey registry types — the single source of truth for both the UI and a future agent MCP.
// Generated registry JSON (public/registry/*) conforms to these shapes.

export type AuthMode =
  | "free"
  | "paid"
  | "x402"
  | "siwx"
  | "apiKey"
  | "apiKey+paid"
  | string;

export interface PaymentOption {
  scheme: string; // "exact"
  network: string; // normalized: "Base" | "Solana" | "Ethereum" | "Polygon" | "Avalanche" | ...
  amount: string; // raw base units, e.g. "40000"
  asset: string; // token contract address or symbol
  payTo?: string; // recipient address
  extra?: Record<string, unknown>;
}

export interface Price {
  amount: number | null; // numeric USD per unit (null = unknown/varies)
  currency: "USD";
  unit: string; // "per call" | "per image" | "per second" | "per 1K chars"
  display: string; // "$0.04 / call" | "Free" | "Varies"
  raw?: string; // original price string from source
  min?: number | null; // ranges / dynamic pricing
  max?: number | null;
  dynamic?: boolean; // price varies by input/demand
  source: "live-402" | "llms.txt" | "openapi" | "search" | "manual";
  note?: string;
}

export interface Probe {
  status: number | null; // last HTTP status (402 = payable, 2xx = free)
  method?: string; // method that produced the verdict
  payable: boolean; // a valid 402 x402 challenge was returned
  free: boolean; // callable 2xx with no credential
  blocked?: boolean; // 403/429/5xx/timeout — ambiguous
  checkedAt: string; // ISO
}

/**
 * Machine-readable async-job descriptor (RUN_RELIABILITY_SPEC 3.1). The ENGINE reads this to detect a
 * pending submit, derive the poll URL, decide whether polling costs money, and find the result — so a
 * provider whose async signal is a non-standard field (e.g. `task_status`) or whose poll URL is derived
 * from a job id is handled generically, NOT charged-as-sync (the CogVideoX-class bug). Per-service DATA;
 * the engine stays generic. Complements the human-facing `ServiceUsage.resultPull`/`outputShape`.
 */
export interface AsyncSpec {
  isAsync: boolean;
  submitStatusField?: string; // dot-path to the status in the submit body (default: scan status|state|task_status|phase)
  submitPendingValues?: string[]; // values meaning "queued/processing" (default: a generic pending set)
  jobIdPath?: string; // dot-path to the job id in the submit body — supports array indices, e.g. "id" | "data.jobId" | "tasks.0.id"
  pollUrlTemplate?: string; // poll URL with {id}/{origin} placeholders, e.g. "{origin}/api/jobs/{id}" (absolute or origin-relative)
  // AXIS 1/4 (HTTP-level async): a 202 submit, or a poll URL delivered only in a response HEADER, are handled
  // AUTOMATICALLY by the engine (202 ⇒ async; Location/Content-Location ⇒ poll URL when no template/body poll_url).
  // No field is needed for those — they're auto-detected. The fields below cover what can't be auto-derived safely.
  poll?: {
    cost: "free" | "siwx" | "per-poll"; // how a poll is PAID (the model) — lets the engine pick free/SIWX/x402 polling.
    // NOTE: no dollar ceiling lives here. The legitimate job cost the poller may authorize is the endpoint's known
    // price (JobDoc.priceUsd, from price.amount); spend limits + an env backstop are the runtime money guardrail.
    method?: "GET" | "POST"; // HTTP method to poll with (default GET). Some providers (2Captcha) require POST.
    body?: Record<string, unknown>; // request body sent with a POST poll; string values templated with {id} (the job id)
    headers?: Record<string, string>; // AXIS 3: request headers for the poll; string values templated with {id} (e.g. {"X-Job-Id":"{id}"})
    statusField?: string; // dot-path to status in the poll body (default: same scan as submit)
    completeValues?: string[]; // values meaning done (default: a generic complete set)
    failedValues?: string[]; // values meaning failed (default: a generic failed set)
    statusFromHttp?: boolean; // AXIS 6: opt-in — when the poll body has NO status field, derive state from the HTTP code (202/pending-ish ⇒ pending; other 2xx ⇒ complete; 5xx ⇒ pending/retry). Use for header-only/no-body status APIs.
    resultPath?: string; // dot-path to the result (URL or data) in the poll body — supports array indices, e.g. "results.0.url"
    // AXIS 7 (result at a SEPARATE endpoint — the "allium class"): once the job is complete, fetch the result from
    // THIS url ({origin}/{id} placeholders) instead of reading it from the poll body, then extract via resultPath.
    // resultCost defaults to "free"; the paid case is cost-capped + at-most-once like a poll. resultMethod default GET.
    resultUrlTemplate?: string;
    resultCost?: "free" | "siwx" | "per-poll";
    resultMethod?: "GET" | "POST";
    resultBody?: Record<string, unknown>; // body for a POST result-fetch; string values templated with {id}
    resultHeaders?: Record<string, string>; // headers for the result-fetch; string values templated with {id}
  };
  maxPolls?: number; // AXIS 6: hard cap on total polls before the engine gives up (terminal "couldn't complete"), so a free/SIWX job can't poll forever. Default MAX_POLLS_DEFAULT.
  pollIntervalSec?: number;
}

export interface Operation {
  name: string; // "Create sandbox" / "Generate image"
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  // Same durable-record rule as Service/Backend (see registry.ts): an op we indexed and TESTED but that
  // no longer works is marked hidden and KEPT, never deleted — so "tried it, it's dead" stays
  // distinguishable from "never indexed it". Hidden ops are filtered out of the served view.
  status?: "active" | "hidden";
  hiddenReason?: Service["hiddenReason"];
  trivial?: boolean; // health/status/models — discovery-only
  audience?: "public" | "internal"; // internal = cron/webhook/admin
  walletScoped?: boolean; // SIWX management op scoped to the signing wallet
  needsApproval?: boolean; // W-S M4: hand-curated — outward/irreversible op (send/call/mail/purchase/publish) → WEB harness pauses for approval before executing. Absent today (registry not yet enriched).
  modelParam?: { name: string; value: string }; // selects THIS model on a shared endpoint
  usage?: ServiceUsage; // Registry QA: how to call this op correctly; surfaced via get_service
  async?: AsyncSpec; // RUN_RELIABILITY_SPEC 3.1: machine-readable async-job detection/polling for the engine
  price: Price;
  authMode: AuthMode;
  probe: Probe;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  instructions: string | null;
  team?: string; // operating team behind this op's HOST (see Backend.team); derived by curate.mjs (teams.mjs).
  payment: { protocols: string[]; accepts: PaymentOption[] };
}

// A backend is one gateway/provider that serves the SAME model (one model → many backends).
export interface Backend {
  provider: string; // gateway/provider name, e.g. "Xona", "Orthogonal"
  providerId: string;
  url: string;
  method: string;
  modelParam?: { name: string; value: string }; // selects this model on a shared multi-model endpoint
  needsApproval?: boolean; // W-S M4: hand-curated outward/irreversible backend → WEB harness pauses for approval
  async?: AsyncSpec; // RUN_RELIABILITY_SPEC 3.1: machine-readable async-job detection/polling for the engine
  hosting?: "custom" | "platform";
  platformName?: string;
  authMode: AuthMode;
  price: Price;
  payment: { protocols: string[]; accepts: PaymentOption[] };
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  probe?: Probe;
  status: "active" | "needs-review" | "hidden";
  firstParty?: boolean; // true if this is the service owner's own endpoint (1P) rather than an aggregator route; the run engine defaults to the 1P backend. Derived from first-party.json by curate.mjs.
  team?: string; // operating team behind this endpoint's HOST (e.g. "BlockRun" | "Merit" | "Sponge" | "Orthogonal"). Derived from host by curate.mjs (scripts/registry/teams.mjs); for trust-based ranking/filtering. Like firstParty, this is about who runs the host, not the underlying model.
}

export interface Service {
  id: string; // stable slug
  kind: "model" | "api";
  name: string; // clean display name
  aka?: string[]; // raw/alias names
  provider: string;
  providerId: string;
  description: string;
  category: string; // slug
  subcategory: string; // slug
  tags: string[];
  modality?: { input: string[]; output: string[] };
  pricing: { headline: string; amount: number | null; currency: "USD"; unit: string };
  media?: { thumbnail?: string; sample?: string };
  operations: Operation[]; // distinct actions (api kind); often empty for model kind
  // Opt-in: this service needs a per-user resource obtained ONCE and reused across runs (create-once
  // pattern). The platform stores userId→value and injects it so agents don't recreate/re-ask each
  // time. See src/lib/mcp/managed.ts + the get_email_inbox tool. Only set on services that need it.
  managedResource?: {
    key: string; // per-user store key, e.g. "agentmail:inbox"
    kind: "provisioned" | "value";
    label: string; // human label, e.g. "Email inbox"
    injectAs?: string; // the input field the value fills when USING the service, e.g. "inbox_id"
    createOperation?: string; // provisioned: the operation that creates it, e.g. "Create inbox"
    idField?: string; // provisioned: response field holding the resource id, e.g. "inbox_id"
    prompt?: string; // value: what to ask the user for, e.g. "your postal address"
  };
  backends?: Backend[]; // for model kind: gateways serving this model (cheapest surfaced)
  usage?: ServiceUsage; // Registry QA: how to call this service correctly; surfaced via get_service
  docs?: { llmTxt?: string; agentMd?: string; openapi?: string } | null;
  source: {
    serviceKey: string; // canonical dedupe key (origin host or sponge id)
    spongeId?: string;
    openapiSpecUrl?: string;
    discoveredVia: string[];
    rawId?: string;
    hosting?: "custom" | "platform";
    platformName?: string;
    lastSyncedAt: string;
  };
  status: "active" | "needs-review" | "hidden";
  // When status === "hidden": WHY it's hidden — our internal track record so we never re-test / re-pay
  // a known-bad service, and so the agent/web app never sees it. Never served (registry.ts strips hidden).
  // "dead" = called and it errored / returned nothing; "broken" = charge-then-fail; "mpp" = MPP-only,
  // not x402; "untested" = never verified working; "needs-input"/"over-cap"/"needs-review" = parked.
  hiddenReason?: "dead" | "broken" | "mpp" | "untested" | "needs-input" | "over-cap" | "needs-review";
}

/**
 * Machine-first usage documentation for an x402 service endpoint.
 * Written by the Registry QA phase; surfaced via `get_service`.
 * A fresh agent given only this block must be able to make a successful paid call.
 */
export interface ServiceUsage {
  status: "verified" | "broken" | "untested";
  verifiedAt?: string; // ISO date of successful paid test
  resultPull: "sync" | "poll" | "siwx" | "none"; // how the work comes back
  auth: "none" | "siwx"; // extra auth beyond payment
  callShape: string; // e.g. "POST {backend.url} with JSON body"
  inputExample: Record<string, unknown>; // a REAL body that produced a real result
  outputShape: string; // where the work is in the response, e.g. "result.url"
  quirks: string[]; // exact gotchas
  needs?: string[]; // run_service gaps still to build (SIWX is shipped → [])
  needsApproval?: boolean; // outward/irreversible → stop-and-ask
  sessionFlow?: {
    createOp: string; // op/path that creates the session (paid x402 call)
    sessionIdField: string; // where the id is in the create response
    actionOps: string[]; // SIWX-only action paths
    closeOp: string; // SIWX-only path that closes the session
    closeBody?: string; // how the id is passed to close
  };
  managedResource?: {
    key: string; label: string; kind: "provisioned" | "value";
    injectAs?: string; createOperation?: string; idField?: string; prompt?: string;
  };
  guide: string; // 2–6 sentence plain-English "how to use this exactly"
  costObservedUsd?: number; // what the test actually paid
  droppedReason?: string; // when status:"broken"
}

export interface EntrySummary {
  id: string;
  kind: "model" | "api";
  name: string;
  provider: string;
  category: string;
  subcategory: string;
  price: { display: string; amount: number | null; unit: string };
  tags: string[];
  description?: string; // short, for browse cards
  domain?: string | null; // brand domain for favicon logos (null → initials fallback)
  thumbnail?: string;
  status: Service["status"];
  hiddenReason?: Service["hiddenReason"]; // track record for hidden entries (never served)
  teams?: string[]; // distinct operating teams across this service's endpoints (e.g. ["BlockRun","Merit"]); for registry-level filtering/ranking. Omitted when no endpoint belongs to a known team. Derived by curate.mjs/apply-teams.mjs from Backend.team.
}

export interface SubcategoryNav { name: string; slug: string; count: number }
export interface CategoryNav { name: string; slug: string; count: number; subcategories: SubcategoryNav[] }

export interface RegistryIndex {
  syncedAt: string;
  categories: CategoryNav[];
  entries: EntrySummary[];
}
