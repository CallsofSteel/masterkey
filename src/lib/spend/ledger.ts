// Masterkey — spend ledger (server-only). The ledger is the source of truth for "what the user
// owes us". Spend accounting on users.billing.spentThisPeriodUsd is atomic ($inc) for concurrency
// safety; period reset is a single conditional atomic update. See MCP_SPEC.md M5 + Appendix R5.

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { firstOfNextMonthISO } from "@/lib/users";
import type { BucketKey } from "@/lib/spend-buckets";
import {
  COLLECTIONS,
  type LedgerDoc,
  type LedgerStatus,
  type RejectReason,
  type UserDoc,
} from "@/lib/mcp/types";

/**
 * Append one ledger row. Returns the FINAL status actually written (callers gate `incSpent` on it).
 *
 * RUN_RELIABILITY_SPEC 1.4 + 1.5 — a "settled" row IS our settlement proof, so it is downgraded to
 * "unconfirmed" when (1.4) it has no tx hash, or (1.5) another "settled" row already carries the same
 * tx hash (two distinct charges must never share one on-chain settlement → that double-counts). The
 * reconciler (2.5) later resolves "unconfirmed" rows.
 */
export async function appendLedger(entry: {
  userId: string;
  connectionId?: string;
  tokenJti?: string;
  serviceId: string;
  serviceName: string;
  operation?: string;
  provider: string;
  backendUrl: string;
  bucket: BucketKey | "all";
  costUsd: number;
  network: string;
  txHash?: string;
  payTo?: string; // provider's x402 recipient — lets the reconciler bind a hashless row to the right tx
  status: LedgerStatus;
  rejectedReason?: RejectReason;
  runId?: string;
}): Promise<LedgerStatus> {
  const db = await getDb();
  const ledger = db.collection<LedgerDoc>(COLLECTIONS.ledger);

  let status: LedgerStatus = entry.status;
  if (status === "settled") {
    if (!entry.txHash) {
      status = "unconfirmed"; // 1.4: no settlement proof
    } else {
      const dup = await ledger.findOne({ txHash: entry.txHash, status: "settled" });
      if (dup) {
        // 1.5: this tx already settled another charge — booking it again would double-count.
        console.warn(`[ledger] settled txHash ${entry.txHash} already on ${dup._id}; booking ${entry.serviceId} as unconfirmed`);
        status = "unconfirmed";
      }
    }
  }

  await ledger.insertOne({
    _id: `led_${randomUUID().replace(/-/g, "")}`,
    createdAt: new Date(),
    ...entry,
    status,
  });
  return status;
}

/** Atomically adjust this-period spend (delta may be negative, e.g. reconciling a reservation). */
export async function incSpent(userId: string, deltaUsd: number): Promise<void> {
  if (!deltaUsd) return;
  const db = await getDb();
  await db
    .collection<UserDoc>(COLLECTIONS.users)
    .updateOne({ _id: userId }, { $inc: { "billing.spentThisPeriodUsd": deltaUsd } });
}

/**
 * Lazily reset the spend period if due. Single conditional atomic update keyed on the OLD
 * periodResetsISO so only one concurrent writer rolls it. Returns the fresh user.
 */
export async function resetPeriodIfDue(user: UserDoc): Promise<UserDoc> {
  if (Date.parse(user.billing.periodResetsISO) > Date.now()) return user;
  const db = await getDb();
  const users = db.collection<UserDoc>(COLLECTIONS.users);
  const next = firstOfNextMonthISO();
  const updated = await users.findOneAndUpdate(
    { _id: user._id, "billing.periodResetsISO": user.billing.periodResetsISO },
    { $set: { "billing.spentThisPeriodUsd": 0, "billing.periodResetsISO": next } },
    { returnDocument: "after" },
  );
  if (updated) return updated;
  // Another writer reset it first — refetch the current state.
  const fresh = await users.findOne({ _id: user._id });
  return fresh ?? user;
}

/**
 * Atomically reserve `estUsd` against the monthly limit: increments spentThisPeriod only if it
 * stays within the limit. Returns true if reserved, false if it would exceed (→ reject).
 */
export async function reserveMonthly(userId: string, estUsd: number, monthlyLimitUsd: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection<UserDoc>(COLLECTIONS.users).findOneAndUpdate(
    { _id: userId, "billing.spentThisPeriodUsd": { $lte: monthlyLimitUsd - estUsd } },
    { $inc: { "billing.spentThisPeriodUsd": estUsd } },
    { returnDocument: "after" },
  );
  return res != null;
}

/** Sum of settled spend since `since`, optionally scoped to a bucket and/or connection (session). */
export async function settledSince(
  userId: string,
  since: Date,
  opts?: { bucket?: BucketKey; connectionId?: string },
): Promise<number> {
  const db = await getDb();
  const match: Record<string, unknown> = { userId, status: "settled", createdAt: { $gte: since } };
  if (opts?.bucket) match.bucket = opts.bucket;
  if (opts?.connectionId) match.connectionId = opts.connectionId;
  const agg = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .aggregate<{ total: number }>([{ $match: match }, { $group: { _id: null, total: { $sum: "$costUsd" } } }])
    .toArray();
  return agg[0]?.total ?? 0;
}

/** All-time settled spend for a connection (session = connection lifetime, Appendix R5). */
export async function settledForConnection(connectionId: string, bucket?: BucketKey): Promise<number> {
  const db = await getDb();
  const match: Record<string, unknown> = { connectionId, status: "settled" };
  if (bucket) match.bucket = bucket;
  const agg = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .aggregate<{ total: number }>([{ $match: match }, { $group: { _id: null, total: { $sum: "$costUsd" } } }])
    .toArray();
  return agg[0]?.total ?? 0;
}

/**
 * Sum of SETTLED spend for a web run (RUN_RELIABILITY_SPEC 2.1). RunDoc.providerCostUsd is DERIVED
 * from this so the three numbers (on-chain ⇄ ledger ⇄ RunDoc) can't diverge: it counts the sync
 * submit + async submit + every paid poll, excludes `unconfirmed`/`failed`, and is correct even for a
 * capped/incomplete job. Idempotent to recompute (crash-safe).
 */
export async function settledCostForRun(runId: string): Promise<number> {
  const db = await getDb();
  const agg = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .aggregate<{ total: number }>([
      { $match: { runId, status: "settled" } },
      { $group: { _id: null, total: { $sum: "$costUsd" } } },
    ])
    .toArray();
  return agg[0]?.total ?? 0;
}

/**
 * Σ of these runs' `unconfirmed` ledger rows — money that left (or may have left) the wallet but isn't
 * counted yet because we can't tie it to a verifiable on-chain settlement (RUN_RELIABILITY_SPEC 1.4).
 *
 * `settledCostForRun` deliberately counts settled rows ONLY, so during the reconciler's ~3–8 min window a
 * run's derived total reads LOW. Surfacing this separately lets the UI say "settling" instead of silently
 * under-reporting spend. Providers that return no `X-Payment-Response` header (StableStudio, Brave,
 * CogVideoX) route through recovery, so this is routine, not exceptional.
 */
export async function unconfirmedCostForRuns(runIds: string[]): Promise<number> {
  if (!runIds.length) return 0;
  const db = await getDb();
  const agg = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .aggregate<{ total: number }>([
      { $match: { runId: { $in: runIds }, status: "unconfirmed" } },
      { $group: { _id: null, total: { $sum: "$costUsd" } } },
    ])
    .toArray();
  return agg[0]?.total ?? 0;
}

// --- Reconciler support (RUN_RELIABILITY_SPEC 2.5) --------------------------------------------

/** `unconfirmed` rows older than `olderThanMs` that the reconciler hasn't resolved yet. */
export async function findUnconfirmedToReconcile(olderThanMs: number, limit = 200): Promise<LedgerDoc[]> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .find({ status: "unconfirmed", reconciledAt: { $exists: false }, createdAt: { $lt: cutoff } })
    .limit(limit)
    .toArray();
}

/** True if a DIFFERENT row already settled this exact tx hash (→ promoting would double-count). */
export async function hasOtherSettledTxHash(txHash: string, excludeId: string): Promise<boolean> {
  const db = await getDb();
  const dup = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .findOne({ txHash, status: "settled", _id: { $ne: excludeId } });
  return dup != null;
}

/** Of the given on-chain tx hashes, the subset ALREADY recorded on any ledger row — so the reconciler's
 *  burst recovery never claims one on-chain tx for two different charges. */
export async function claimedTxHashes(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const db = await getDb();
  const rows = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .find({ txHash: { $in: hashes } }, { projection: { txHash: 1 } })
    .toArray();
  return new Set(rows.map((r) => r.txHash).filter((h): h is string => !!h));
}

/**
 * Atomically transition an `unconfirmed` row → `settled`/`voided`. Idempotent: returns true ONLY for
 * the caller that actually flipped it from `unconfirmed` (so `incSpent` runs exactly once on promote,
 * even if two reconciler passes race). `txHash` records the on-chain proof the reconciler recovered for a
 * previously-hashless row.
 */
export async function resolveUnconfirmedRow(
  rowId: string,
  to: "settled" | "voided",
  txHash?: string,
): Promise<boolean> {
  const db = await getDb();
  const set: Record<string, unknown> = { status: to, reconciledAt: new Date() };
  if (to === "settled" && txHash) set.txHash = txHash;
  const res = await db
    .collection<LedgerDoc>(COLLECTIONS.ledger)
    .updateOne({ _id: rowId, status: "unconfirmed" }, { $set: set });
  return res.modifiedCount === 1;
}
