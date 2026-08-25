// Masterkey — stale-active run reaper (W11 / W-S C7, corrected v2.2). Frees the one-active-run slot
// for GENUINELY-dead runs without killing healthy paused ones. Rules:
//   • Only `running` runs with a stale lease are candidates (findStaleRunningRuns) — `awaiting_approval`
//     is NEVER reaped on lease (it's parked on a waitpoint and can't heartbeat; bounded by the 24h TTL).
//   • Lease is only a PRE-FILTER: before reaping, confirm the engine run is actually dead via
//     runs.retrieve (a run on a checkpointed wait — e.g. job-polling — has a stale lease but is alive).
//   • Can't confirm → DON'T reap (avoid false-positive kills); the next sweep retries.

import { schedules, runs } from "@trigger.dev/sdk";
import { findStaleRunningRuns, setRunStatus, appendStep } from "@/lib/chat/db";

const STALE_MS = 3 * 60 * 1000; // lease stale after 3 min without a heartbeat
// Engine statuses that mean the durable run is no longer executing (safe to reap the orphaned RunDoc).
const DEAD = new Set(["FAILED", "CANCELED", "CRASHED", "EXPIRED", "TIMED_OUT", "COMPLETED"]);

export async function sweepStaleRuns(staleMs = STALE_MS): Promise<{ candidates: number; reaped: number }> {
  const candidates = await findStaleRunningRuns(staleMs);
  let reaped = 0;
  for (const run of candidates) {
    if (!run.engineRunId) continue; // can't confirm death without an engine handle → leave it
    try {
      const tr = await runs.retrieve(run.engineRunId);
      if (DEAD.has(tr.status)) {
        await setRunStatus(run._id, "failed"); // terminal → frees the one-active-run slot
        await appendStep({
          runId: run._id,
          userId: run.userId,
          kind: "error",
          data: { message: `Run reaped: the durable run is no longer active (engine status ${tr.status}).` },
        });
        reaped++;
      }
      // else EXECUTING/WAITING/QUEUED/… → alive (lease was stale during a checkpointed wait) → leave it.
    } catch {
      // Couldn't reach the engine → DON'T reap; retry next sweep.
    }
  }
  return { candidates: candidates.length, reaped };
}

export const runReaper = schedules.task({
  id: "masterkey-run-reaper",
  cron: "*/2 * * * *", // every 2 minutes
  run: async () => sweepStaleRuns(),
});
