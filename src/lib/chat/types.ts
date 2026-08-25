// Masterkey — WEB layer (human-facing durable runs) Mongo doc types. Server-only.
// Transcribed from WEB_SPEC.md §5. Mongo is the source of truth; the browser only subscribes.
// Dates are ISO-8601 strings (lexicographically sortable → safe to index for ordering).

import type { RunResult } from "@/lib/mcp/types";

/** Lifecycle of one autonomous bundle run. Active states = {queued,running,awaiting_approval}. */
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "complete"
  | "failed"
  | "capped"
  | "canceled";

/** The non-terminal ("in-flight") run states. NOTE: the one-active-run lock (W-S C7) that used this
 *  was REMOVED 2026-06-06 — concurrent runs per user are allowed. Retained as the canonical "is a run
 *  in-flight?" set (e.g. for a future per-transport serialization like iMessage one-run-per-phone). */
export const ACTIVE_RUN_STATES: RunStatus[] = ["queued", "running", "awaiting_approval"];

/** Kinds of transcript step the UI renders (StepCard polymorphism, W8). */
export type RunStepKind =
  | "text" // assistant prose (markdown)
  | "tool_call" // {tool,input} — tool-activity card
  | "result" // a RunResult (see §10 / W7 renderer registry)
  | "pending" // {jobId,serviceName} — in-flight provider job
  | "approval" // {stepId, action, draftId, decision?} — send-approval card
  | "error" // friendly error block
  | "warning" // pre-run cost estimate notice
  | "needs_reconcile" // {stepKey} — synchronous paid call crashed pre-persist (v2.2)
  | "done"; // {providerCostUsd, remainingUsd}

/** Outward action classes that require approval before executing (W6 allowlist). */
// Send actions need explicit approval (default-deny). "budget" is a non-send pause: the per-run budget
// gate (W-S M7) reuses the same waitpoint to ask the user to raise this run's budget or stop.
export type ApprovalAction = "email" | "sms" | "mail" | "call" | "purchase" | "publish" | "budget";

// runs — one autonomous bundle execution, scoped to a user.
export interface RunDoc {
  _id: string; // "run_…"
  userId: string;
  goal: string; // the user's outcome prompt
  seedServiceId?: string; // if launched from a catalog service
  seedBackendProviderId?: string; // user-picked provider/endpoint selector key for the seeded service
  status: RunStatus;
  engineRunId?: string; // Trigger.dev run id (adapter handle) — set by Track B
  title: string; // goal (≤60 chars)
  providerCostUsd: number; // running sum of settled MCP costs this run (derived mirror of the ledger)
  budgetUsd?: number; // per-run ceiling (W-S M7)
  parentRunId?: string; // follow-up of a finished run (W-S M10)
  rootRunId?: string; // the first run of this chat session; follow-ups inherit it (for the session total)
  sessionCostUsd?: number; // COMPUTED (not persisted): Σ providerCostUsd across this run's session chain
  pendingCostUsd?: number; // COMPUTED (not persisted): Σ `unconfirmed` ledger cost across the session —
  // paid but not yet tied to an on-chain settlement. sessionCostUsd counts SETTLED rows only, so without
  // this the total reads low for the reconciler's ~3–8 min window. Rendered as "settling", never added in.
  leaseISO?: string; // heartbeat — updated ONLY while the task is actively executing (reaper, v2.2 / W-S C7)
  // Server-ONLY waitpoint handle for the currently-open send-approval (W-S C5). The `tokenId` is the
  // completion credential surface — it MUST be stripped from any browser-facing response.
  pendingApproval?: { toolUseId: string; tokenId: string; action: ApprovalAction };
  createdISO: string;
  updatedISO: string;
}

// run_steps — the durable, replayable transcript (UI renders from these).
export interface RunStepDoc {
  _id: string; // "rs_…"
  runId: string;
  userId: string;
  idx: number; // DISPLAY order only — non-deterministic across replay; never used in an idempotency key
  seq?: number; // per-content-key occurrence counter (durable; the :seq=N in the step key) — paid steps only
  stepKey?: string; // the seq-bearing idempotency key (paid steps); UNIQUE, sparse
  kind: RunStepKind;
  data: unknown; // shape depends on kind (see RunStepKind comments / §5)
  createdISO: string;
}

// run_assets — uploaded inputs (Blob) + outputs mirrored to Blob for the library.
export interface RunAssetDoc {
  _id: string; // "ra_…"
  userId: string;
  runId?: string;
  kind: "input" | "output";
  url: string; // the durable (Blob) URL served to the library
  sourceUrl?: string; // original provider URL an output was mirrored FROM (replay-safe dedupe key)
  mime: string;
  bytes?: number;
  serviceId?: string;
  createdISO: string;
}

/** Convenience: the result-step payload is a RunResult (shared MCP contract, R6 / §10). */
export type ResultStepData = RunResult;
