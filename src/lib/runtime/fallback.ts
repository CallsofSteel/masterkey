// Masterkey — fallback RunRuntime (server-only). Mongo-backed, NO durable engine. This is the
// Track-A implementation of the §6 seam: the RunDoc is created by POST /api/runs and sits `queued`;
// the browser renders the persisted transcript via the polling useRunSubscription. Track B replaces
// this with the Trigger.dev impl (tasks.trigger + waitpoints + Realtime) behind the same interface.

import type { RunRuntime } from "@/lib/runtime/types";
import { getRun as dbGetRun } from "@/lib/chat/db";

export const fallbackRuntime: RunRuntime = {
  async start() {
    // No engine wired in Track A. Return empty handles; the run stays `queued` until Track B's
    // durable task executes it. (Mongo is the source of truth either way.)
    return { engineRunId: "", publicAccessToken: "" };
  },

  async resumeApproval() {
    throw new Error(
      "resumeApproval requires the durable engine (Track B / Trigger.dev) — not available in the fallback runtime",
    );
  },

  async cancel() {
    // No engine run to terminate in the fallback; the caller still marks the RunDoc canceled.
  },

  async getRun(runId) {
    const run = await dbGetRun(runId);
    return { status: run?.status ?? "failed" };
  },
};
