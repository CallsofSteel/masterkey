// Masterkey — the durable run task (W4/W5/W6). The thin Trigger shell around the engine-agnostic
// brain (brain.ts): it injects the durable primitives — `waitForApproval` (a Trigger waitpoint) and
// `sleep` (`wait.for`, $0 idle) — and heartbeats the lease. maxDuration: timeout.None so a multi-hour
// approval pause is never killed by duration. The brain persists the transcript to Mongo (the browser
// subscribes via the §6 polling hook). Money safety lives in the MCP (idempotency) + brain (seq).

import { task, wait, timeout } from "@trigger.dev/sdk";
import { runAgent, type ApprovalDecision } from "@/lib/agent/brain";
import { patchRun, setPendingApproval, clearPendingApproval } from "@/lib/chat/db";

export interface MasterkeyRunPayload {
  runId: string;
  userId: string;
  goal: string;
  seedServiceId?: string;
  seedBackendProviderId?: string;
  parentRunId?: string;
  assetUrls?: string[];
  bundleRecipe?: string; // pre-compiled "/<slug>" recipe (spec §6.2)
  mcpToken: string;
  origin: string;
}

export const masterkeyRun = task({
  id: "masterkey-run",
  maxDuration: timeout.None, // never kill a long-paused (awaiting-approval) run by duration cap
  run: async (payload: MasterkeyRunPayload) => {
    await patchRun(payload.runId, { status: "running", leaseISO: new Date().toISOString() });

    return runAgent({
      runId: payload.runId,
      userId: payload.userId,
      goal: payload.goal,
      seedServiceId: payload.seedServiceId,
      seedBackendProviderId: payload.seedBackendProviderId,
      parentRunId: payload.parentRunId,
      assetUrls: payload.assetUrls,
      bundleRecipe: payload.bundleRecipe,
      mcpToken: payload.mcpToken,
      origin: payload.origin,

      // Durable send-approval gate: pause on a waitpoint (token id kept SERVER-ONLY on the RunDoc),
      // resume on the ownership-checked /approve route's completeToken. r.ok===false = timed out → send nothing.
      waitForApproval: async (req) => {
        const t = await wait.createToken({ timeout: "24h", tags: [`run:${payload.runId}`] });
        await setPendingApproval(payload.runId, { toolUseId: req.toolUseId, tokenId: t.id, action: req.action });
        const r = await wait.forToken<ApprovalDecision>(t);
        await clearPendingApproval(payload.runId, "running");
        if (!r.ok) return { action: "reject" as const };
        return r.output;
      },

      // Durable poll wait between get_result polls — checkpointed, $0 compute (Appendix W-A).
      sleep: (seconds: number) => wait.for({ seconds }),
    });
  },
});
