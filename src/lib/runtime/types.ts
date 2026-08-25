// Masterkey — runtime-adapter seam types (WEB_SPEC.md §6). Engine-agnostic so Trigger.dev →
// (Vercel Workflow / Inngest / Fly worker) is mechanical. Pure types — safe to import anywhere.

import type { RunDoc, RunStatus, RunStepDoc } from "@/lib/chat/types";

export type { RunDoc, RunStatus, RunStepDoc };

/** A human's decision on a paused send-approval waitpoint. Mirror of brain.ts's ApprovalDecision
 *  (kept separate: the brain's narrower `payload: { input? }` can't live in this pure-types module).
 *  Keep the `action` union in sync with src/lib/agent/brain.ts. */
export type ApprovalDecision = { action: "approve" | "edit" | "regenerate" | "reject"; payload?: unknown };

export interface RunStartInput {
  runId: string;
  userId: string;
  goal: string;
  seedServiceId?: string;
  seedBackendProviderId?: string; // user-picked provider/endpoint for the seeded service
  parentRunId?: string; // follow-up: replay the prior session's conversation as context
  assetUrls: string[];
  bundleRecipe?: string; // pre-compiled "/<slug>" recipe text (spec §6.2), resolved+compiled at /api/runs
}

/** Server-side engine control surface. */
export interface RunRuntime {
  /** Begin the durable run; returns the engine handle + a browser-subscribe token. */
  start(input: RunStartInput): Promise<{ engineRunId: string; publicAccessToken: string }>;
  /** Complete a paused approval waitpoint (server-side only). */
  resumeApproval(runId: string, token: string, decision: ApprovalDecision): Promise<void>;
  /** Terminate a running/paused engine run (cancel). No-op if the engine has no live run. */
  cancel(engineRunId: string): Promise<void>;
  /** Server-side status read. */
  getRun(runId: string): Promise<{ status: RunStatus }>;
}

/** One run within a chat session: the run doc + its transcript. */
export interface SessionSegment {
  run: RunDoc;
  steps: RunStepDoc[];
}

/** What the client subscription hook returns. Session-aware: `segments` is the whole chat session
 *  (root + follow-ups, chronological); `run` is the LATEST run (drives status + the reply target). */
export interface RunSubscriptionResult {
  run: RunDoc | null;
  segments: SessionSegment[];
  status: RunStatus;
  /** True once the first response has been processed (distinguishes loading from not-found). */
  loaded: boolean;
  /** Force an immediate refetch + resume polling (used after sending a follow-up). */
  refetch: () => void;
}
