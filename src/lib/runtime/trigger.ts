// Masterkey — Trigger.dev implementation of the §6 RunRuntime seam (server-only). Mints the run's
// first-party MCP token, triggers the durable masterkeyRun task (idempotencyKey = runId so a double-
// submit dedupes — W-S C7), completes approval waitpoints, and cancels runs. The browser subscribes
// via the polling useRunSubscription (reads Mongo, which the task populates) — Realtime streaming is a
// future enhancement, so we don't mint a public Realtime token here (v1).

import { tasks, wait, runs } from "@trigger.dev/sdk";
import type { masterkeyRun } from "@/trigger/masterkey-run";
import type { RunRuntime, ApprovalDecision } from "@/lib/runtime/types";
import { mintFirstPartyToken } from "@/lib/agent/first-party-token";
import { getRun as dbGetRun } from "@/lib/chat/db";

export const triggerRuntime: RunRuntime = {
  async start(input) {
    const { token } = await mintFirstPartyToken(input.userId);
    const origin = process.env.MASTERKEY_ORIGIN ?? "http://localhost:3000";
    const handle = await tasks.trigger<typeof masterkeyRun>(
      "masterkey-run",
      {
        runId: input.runId,
        userId: input.userId,
        goal: input.goal,
        seedServiceId: input.seedServiceId,
        seedBackendProviderId: input.seedBackendProviderId,
        parentRunId: input.parentRunId,
        assetUrls: input.assetUrls,
        bundleRecipe: input.bundleRecipe,
        mcpToken: token,
        origin,
      },
      { idempotencyKey: input.runId },
    );
    return { engineRunId: handle.id, publicAccessToken: "" };
  },

  async resumeApproval(_runId, token, decision) {
    await wait.completeToken(token, decision as ApprovalDecision);
  },

  async cancel(engineRunId) {
    if (!engineRunId) return;
    await runs.cancel(engineRunId);
  },

  async getRun(runId) {
    const run = await dbGetRun(runId);
    return { status: run?.status ?? "failed" };
  },
};
