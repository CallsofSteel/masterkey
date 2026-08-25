// Masterkey — WEB layer Mongo CRUD for runs / steps / assets (server-only). Reuses getDb().
// Mongo is the source of truth (WEB_SPEC.md §5); the browser subscribes via the runtime seam (§6).
// Never import from client code.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { COLLECTIONS } from "@/lib/mcp/types";
import { unconfirmedCostForRuns } from "@/lib/spend/ledger";
import {
  type RunDoc,
  type RunStepDoc,
  type RunStepKind,
  type RunAssetDoc,
  type RunStatus,
  type ApprovalAction,
} from "@/lib/chat/types";

const TERMINAL_STATES: RunStatus[] = ["complete", "failed", "capped", "canceled"];

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function isDupKeyError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: number }).code === 11000;
}

/** Default per-run budget ceiling (W-S M7). `MASTERKEY_DEFAULT_RUN_BUDGET_USD`; 0/empty/invalid → no
 *  per-run budget (the gate is then inert). Applied to every run unless the caller passes budgetUsd. */
export function defaultRunBudgetUsd(): number | undefined {
  const v = Number(process.env.MASTERKEY_DEFAULT_RUN_BUDGET_USD ?? "5");
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// --- Indexes (idempotent; memoized per process) ------------------------------------------------
let _ensured: Promise<void> | undefined;

async function createIndexes(): Promise<void> {
  const db = await getDb();
  // The hard one-active-run-per-user lock was REMOVED — concurrent runs are allowed. Cost is bounded by
  // per-call + per-user spend limits (M5), and Trigger.dev handles run concurrency natively, so the lock
  // wasn't needed and kept causing slot lockouts. Drop the old unique index if a prior deploy created it
  // (self-heals prod so the constraint stops enforcing). Idempotent — ignore "index not found".
  await db.collection(COLLECTIONS.runs).dropIndex("one_active_run_per_user").catch(() => {});
  await Promise.all([
    // runs — per-user list newest-first; ops status sweep; reaper pre-filter (stale `running`).
    db.collection(COLLECTIONS.runs).createIndex({ userId: 1, updatedISO: -1 }),
    db.collection(COLLECTIONS.runs).createIndex({ status: 1 }),
    db.collection(COLLECTIONS.runs).createIndex({ status: 1, leaseISO: 1 }), // reaper pre-filter (running only)
    // run_steps — replay order; UNIQUE+sparse stepKey for replay/cost dedupe (v2.1).
    db.collection(COLLECTIONS.runSteps).createIndex({ runId: 1, idx: 1 }),
    db.collection(COLLECTIONS.runSteps).createIndex({ stepKey: 1 }, { unique: true, sparse: true }),
    // run_assets — per-user gallery newest-first.
    db.collection(COLLECTIONS.runAssets).createIndex({ userId: 1, createdISO: -1 }),
  ]);
}

/** Ensure all WEB-layer indexes exist. Memoized per process so it runs at most once. */
export async function ensureChatIndexes(): Promise<void> {
  if (!_ensured) _ensured = createIndexes();
  return _ensured;
}

// --- Runs --------------------------------------------------------------------------------------

/**
 * Create a `queued` RunDoc and return it. Concurrent runs per user are allowed — the old hard
 * one-active-run lock was removed (cost is bounded by per-call + per-user spend limits, and Trigger
 * handles concurrency natively). The caller starts the durable engine and navigates to /run/[id].
 */
export async function createRun(input: {
  userId: string;
  goal: string;
  seedServiceId?: string;
  seedBackendProviderId?: string;
  parentRunId?: string;
  budgetUsd?: number;
}): Promise<RunDoc> {
  await ensureChatIndexes();
  const db = await getDb();
  const col = db.collection<RunDoc>(COLLECTIONS.runs);
  const now = new Date().toISOString();
  const budgetUsd = input.budgetUsd ?? defaultRunBudgetUsd(); // W-S M7: apply the default budget if unset
  // Session grouping for the cumulative chat total: a follow-up inherits its parent's rootRunId (or the
  // parent's id if the parent is itself a root). A fresh run has no rootRunId — its session is itself.
  let rootRunId: string | undefined;
  if (input.parentRunId) {
    const parent = await col.findOne({ _id: input.parentRunId }, { projection: { rootRunId: 1 } });
    rootRunId = parent?.rootRunId ?? input.parentRunId;
  }
  const run: RunDoc = {
    _id: id("run"),
    userId: input.userId,
    goal: input.goal,
    ...(input.seedServiceId ? { seedServiceId: input.seedServiceId } : {}),
    ...(input.seedBackendProviderId ? { seedBackendProviderId: input.seedBackendProviderId } : {}),
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(rootRunId ? { rootRunId } : {}),
    ...(budgetUsd != null ? { budgetUsd } : {}),
    status: "queued",
    title: input.goal.trim().slice(0, 60) || "Untitled run",
    providerCostUsd: 0,
    createdISO: now,
    updatedISO: now,
  };
  await col.insertOne(run);
  return run;
}

export async function getRun(runId: string): Promise<RunDoc | null> {
  const db = await getDb();
  return db.collection<RunDoc>(COLLECTIONS.runs).findOne({ _id: runId });
}

/** Σ providerCostUsd across the whole chat session (the run's chain): the root + every follow-up that
 *  inherited its rootRunId. Used for the cumulative session total shown atop the run view. */
export async function sessionCostUsd(run: RunDoc): Promise<number> {
  const db = await getDb();
  const sessionRoot = run.rootRunId ?? run._id;
  const rows = await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .find(
      { userId: run.userId, $or: [{ _id: sessionRoot }, { rootRunId: sessionRoot }] },
      { projection: { providerCostUsd: 1 } },
    )
    .toArray();
  return rows.reduce((sum, r) => sum + (r.providerCostUsd ?? 0), 0);
}

/** Σ UNCONFIRMED ledger cost across the run's session chain — spend awaiting on-chain reconciliation.
 *  `sessionCostUsd` above counts settled rows only, so for the reconciler's ~3–8 min window a session
 *  total reads low. The run view shows this alongside as "settling" rather than under-reporting. */
export async function sessionPendingCostUsd(run: RunDoc): Promise<number> {
  const db = await getDb();
  const sessionRoot = run.rootRunId ?? run._id;
  const rows = await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .find({ userId: run.userId, $or: [{ _id: sessionRoot }, { rootRunId: sessionRoot }] }, { projection: { _id: 1 } })
    .toArray();
  return unconfirmedCostForRuns(rows.map((r) => r._id));
}

/** The whole chat session a run belongs to (root + every follow-up), chronological, each with its
 *  transcript — for the continuous session view. Ownership-checked via the anchor run; null if not owned. */
export async function getSessionForUser(
  runId: string,
  userId: string,
): Promise<{ latest: RunDoc; segments: { run: RunDoc; steps: RunStepDoc[] }[] } | null> {
  const run = await getRunForUser(runId, userId);
  if (!run) return null;
  const db = await getDb();
  const root = run.rootRunId ?? run._id;
  const runs = await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .find({ userId, $or: [{ _id: root }, { rootRunId: root }] })
    .sort({ createdISO: 1 })
    .toArray();
  const ordered = runs.length ? runs : [run];
  const segments = await Promise.all(ordered.map(async (r) => ({ run: r, steps: await getSteps(r._id) })));
  return { latest: ordered[ordered.length - 1], segments };
}

/** Ownership-checked read (returns null if the run doesn't exist OR isn't the user's — 404, no disclosure). */
export async function getRunForUser(runId: string, userId: string): Promise<RunDoc | null> {
  const db = await getDb();
  return db.collection<RunDoc>(COLLECTIONS.runs).findOne({ _id: runId, userId });
}

export async function listRunsForUser(userId: string, limit = 50): Promise<RunDoc[]> {
  const db = await getDb();
  return db
    .collection<RunDoc>(COLLECTIONS.runs)
    .find({ userId })
    .sort({ updatedISO: -1 })
    .limit(limit)
    .toArray();
}

/** Patch a run (always bumps updatedISO). */
export async function patchRun(runId: string, patch: Partial<Omit<RunDoc, "_id" | "userId">>): Promise<void> {
  const db = await getDb();
  await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .updateOne({ _id: runId }, { $set: { ...patch, updatedISO: new Date().toISOString() } });
}

export async function setRunStatus(runId: string, status: RunStatus): Promise<void> {
  await patchRun(runId, { status });
}

/** Open a send-approval waitpoint: store the server-only tokenId + flip to awaiting_approval. */
export async function setPendingApproval(
  runId: string,
  pending: { toolUseId: string; tokenId: string; action: ApprovalAction },
): Promise<void> {
  const db = await getDb();
  await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .updateOne({ _id: runId }, { $set: { pendingApproval: pending, status: "awaiting_approval", updatedISO: new Date().toISOString() } });
}

/** Resolve the open waitpoint: clear it and set the next status (running on resume, canceled on cancel). */
export async function clearPendingApproval(runId: string, status: RunStatus): Promise<void> {
  const db = await getDb();
  await db
    .collection<RunDoc>(COLLECTIONS.runs)
    .updateOne({ _id: runId }, { $set: { status, updatedISO: new Date().toISOString() }, $unset: { pendingApproval: "" } });
}

/** Strip server-only fields (waitpoint tokenId) before sending a run to the browser (W-S C5). */
export function redactRunForClient(run: RunDoc): RunDoc {
  const { pendingApproval, ...safe } = run;
  // Keep a non-secret hint that an approval is open (the action), drop the tokenId.
  return pendingApproval
    ? ({ ...safe, pendingApproval: { toolUseId: pendingApproval.toolUseId, action: pendingApproval.action, tokenId: "" } } as RunDoc)
    : (safe as RunDoc);
}

/** True when the status is terminal (run is finished and the active slot is freed). */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Reaper pre-filter (W-S C7 / v2.2): runs that are `running` with a stale/missing lease. ONLY
 * `running` is lease-eligible — `awaiting_approval` is bounded by the waitpoint TTL and is parked
 * (can't heartbeat), so it must NEVER be reaped on lease alone; `queued` is bounded separately. The
 * caller still confirms actual death via `runs.retrieve` before reaping (lease is only a pre-filter).
 */
export async function findStaleRunningRuns(staleMs: number, limit = 50): Promise<RunDoc[]> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  return db
    .collection<RunDoc>(COLLECTIONS.runs)
    .find({ status: "running", $or: [{ leaseISO: { $exists: false } }, { leaseISO: { $lt: cutoff } }] })
    .limit(limit)
    .toArray();
}

// --- Steps -------------------------------------------------------------------------------------

/**
 * Append a transcript step. `idx` is display order (count-based; single-writer in v1). The durable
 * brain (Track B) supplies deterministic `seq`/`stepKey` for paid steps — see WEB_SPEC §0/W4.
 */
export async function appendStep(input: {
  runId: string;
  userId: string;
  kind: RunStepKind;
  data: unknown;
  seq?: number;
  stepKey?: string;
}): Promise<RunStepDoc> {
  const db = await getDb();
  const col = db.collection<RunStepDoc>(COLLECTIONS.runSteps);
  const idx = await col.countDocuments({ runId: input.runId });
  const step: RunStepDoc = {
    _id: id("rs"),
    runId: input.runId,
    userId: input.userId,
    idx,
    kind: input.kind,
    data: input.data,
    ...(input.seq != null ? { seq: input.seq } : {}),
    ...(input.stepKey ? { stepKey: input.stepKey } : {}),
    createdISO: new Date().toISOString(),
  };
  await col.insertOne(step);
  return step;
}

export async function getSteps(runId: string): Promise<RunStepDoc[]> {
  const db = await getDb();
  return db.collection<RunStepDoc>(COLLECTIONS.runSteps).find({ runId }).sort({ idx: 1 }).toArray();
}

// --- Replay-safe brain persistence (idempotent; the durable loop re-runs from the top on crash) ----

/** Persist the assistant turn's plan BEFORE executing any tool (commit-plan-before-execute, W-S v2.2).
 *  Idempotent on (runId, turn) so a crash-replay doesn't double-write. */
export async function persistPlanStep(input: {
  runId: string;
  userId: string;
  turn: number;
  data: unknown;
}): Promise<void> {
  const db = await getDb();
  const col = db.collection<RunStepDoc>(COLLECTIONS.runSteps);
  if (await col.findOne({ runId: input.runId, kind: "tool_call", "data.turn": input.turn })) return;
  const idx = await col.countDocuments({ runId: input.runId });
  await col.insertOne({
    _id: id("rs"),
    runId: input.runId,
    userId: input.userId,
    idx,
    kind: "tool_call",
    data: input.data,
    createdISO: new Date().toISOString(),
  });
}

/** Append a UI/transcript step (text/result/pending/approval/error/warning/done), idempotent on a
 *  caller-supplied marker (toolUseId for results) so replays no-op.
 *
 *  RUN_RELIABILITY_SPEC 2.1: RunDoc.providerCostUsd is no longer $inc'd here from a per-step cost — it
 *  is DERIVED from the run's settled ledger rows (see persistResult → settledCostForRun) so the ledger
 *  is the single source of truth and the three cost numbers can't diverge. */
export async function persistStepOnce(input: {
  runId: string;
  userId: string;
  kind: RunStepKind;
  marker: string; // e.g. `result:${toolUseId}` or `text:${turn}`
  data: unknown;
  stepKey?: string;
}): Promise<void> {
  const db = await getDb();
  const col = db.collection<RunStepDoc>(COLLECTIONS.runSteps);
  if (await col.findOne({ runId: input.runId, "data._marker": input.marker })) return;
  const idx = await col.countDocuments({ runId: input.runId });
  const data = { ...(input.data as Record<string, unknown>), _marker: input.marker };
  try {
    await col.insertOne({
      _id: id("rs"),
      runId: input.runId,
      userId: input.userId,
      idx,
      kind: input.kind,
      data,
      ...(input.stepKey ? { stepKey: input.stepKey } : {}),
      createdISO: new Date().toISOString(),
    });
  } catch (e) {
    if (isDupKeyError(e)) return; // raced replay on the unique stepKey index → no-op
    throw e;
  }
}

// --- Assets ------------------------------------------------------------------------------------

export async function recordAsset(input: {
  userId: string;
  runId?: string;
  kind: "input" | "output";
  url: string;
  sourceUrl?: string;
  mime: string;
  bytes?: number;
  serviceId?: string;
}): Promise<RunAssetDoc> {
  const db = await getDb();
  const asset: RunAssetDoc = {
    _id: id("ra"),
    userId: input.userId,
    ...(input.runId ? { runId: input.runId } : {}),
    kind: input.kind,
    url: input.url,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    mime: input.mime,
    ...(input.bytes != null ? { bytes: input.bytes } : {}),
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    createdISO: new Date().toISOString(),
  };
  await db.collection<RunAssetDoc>(COLLECTIONS.runAssets).insertOne(asset);
  return asset;
}

export async function listOutputAssetsForUser(userId: string, limit = 100): Promise<RunAssetDoc[]> {
  const db = await getDb();
  return db
    .collection<RunAssetDoc>(COLLECTIONS.runAssets)
    .find({ userId, kind: "output" })
    .sort({ createdISO: -1 })
    .limit(limit)
    .toArray();
}

export async function listAssetsForRun(runId: string): Promise<RunAssetDoc[]> {
  const db = await getDb();
  return db.collection<RunAssetDoc>(COLLECTIONS.runAssets).find({ runId }).sort({ createdISO: 1 }).toArray();
}

/** Associate previously-uploaded input assets (by URL) with a run, scoped to the owner. */
export async function attachAssetsToRun(userId: string, runId: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const db = await getDb();
  await db
    .collection<RunAssetDoc>(COLLECTIONS.runAssets)
    .updateMany({ userId, url: { $in: urls }, kind: "input" }, { $set: { runId } });
}
