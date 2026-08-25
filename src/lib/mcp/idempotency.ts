// Masterkey — run_service idempotency state machine (server-only, M7 amendment).
//
// THE SOLE money-layer double-charge guard. Trigger.dev (the WEB_SPEC durable runtime) does NOT memoize
// inline calls — a crashed/retried durable task re-runs its body from the top and re-fires the inline MCP
// HTTP call. So nothing in the runtime prevents a double-charge; this record does. It is a crash-safe
// state machine keyed on the caller's `idempotencyKey`, NOT a "written at reserve time" marker.
//
// Caller (WEB harness) passes a content-hash + durable-seq key — opaque to us; we treat it as a blob and
// dedupe on (userId, key). Distinct keys (e.g. an intentional ":seq=1" duplicate) are independent → both
// pay. See MCP_SPEC.md "M7 amendment" + WEB_SPEC.md Appendix W-S.
//
// SEMANTICS (v1, VERIFIED baseline = at-most-once for the synchronous-pay window):
//   - claim → in_progress (bounded lease) → settle (store outcome) | settled_failure (nothing paid → retryable).
//   - duplicate settled       → return the stored outcome, never re-pay.
//   - duplicate in_progress, live lease → "in_progress" (caller waits/retries; never pays).
//   - duplicate in_progress, EXPIRED lease (worker died mid-flight):
//       · async with a persisted jobId → "async_recover" (re-poll get_result — exactly-once).
//       · synchronous (no confirmable tx) → "needs_reconcile" — NEVER blind re-pay (favor a rare,
//         refundable lost-payment over a double-charge), surfaced to the user for refund/retry.
//   - duplicate settled_failure → re-claim and proceed (a transient 5xx must not poison the key for ~TTL).
//
// EXACTLY-ONCE-ON-BASE UPGRADE (LIVE-PROVEN 2026-06-05, not yet wired): switch the Base pay path from
// `paidFetch` (Sponge handles 402/v1+v2/MPP/chain/settle for us, but mints a FRESH nonce per call → no
// replay handle → at-most-once) to the two-phase `createX402Payment` flow:
//   1. `wallet.createX402Payment({ chain:"base", to, amount, resource_url, valid_for_seconds, http_method })`
//      SIGNS a reusable EIP-3009 authorization WITHOUT settling; persist its `paymentPayloadBase64` here
//      (on the run_idempotency doc) BEFORE broadcast.
//   2. Repackage `payload{authorization,signature}` into the STANDARD x402 envelope
//      `base64({x402Version:1,scheme:"exact",network:"base",payload})` and submit to the resource yourself
//      as the `X-PAYMENT` header — NOT Sponge's `headerName:"PAYMENT-SIGNATURE"` (real x402 resources want
//      `X-PAYMENT`; confirmed live). Persist the 200's `X-PAYMENT-RESPONSE.transaction`.
//   3. Expired-lease recovery: decide via the canonical on-chain `authorizationState(from, nonce)` read on
//      the USDC contract (0x833589fc…, read-only eth_call via BASE_RPC_URL, no gas) — NOT the facilitator
//      rejection string (the live test returned a GENERIC "Failed to verify payment: invalid_payload", never
//      "authorization is used", so the string is unreliable). true ⇒ already settled (mark settled, never
//      re-pay); false ⇒ re-broadcast the saved base64 (still within validBefore) → settles exactly once.
// PROVEN live (US Census Geocoder, $0.001 Base): settle → 200 + tx; replay same auth → 402, no second debit.
// Until this is wired, the synchronous recovery branch below is at-most-once (needs_reconcile). Off-Base
// (Solana/Tempo/MPP) and the default paidFetch path stay at-most-once regardless.

import { getDb } from "@/lib/db";
import { COLLECTIONS, type RunIdempotencyDoc } from "@/lib/mcp/types";

// A sync pay (pre-flight fetch + Sponge settle) is seconds; keep the lease short so a dead worker's key
// is reclaimable quickly, but longer than the slowest realistic pay. Async submits extend it (markJobId).
const LEASE_MS = 120_000;

function id(userId: string, key: string): string {
  return `${userId}::${key}`;
}

/** Result of a claim attempt. "fresh" = we own the slot, proceed to pay. */
export type ClaimResult<E> =
  | { kind: "fresh" }
  | { kind: "settled"; outcome: E }
  | { kind: "in_progress" }
  | { kind: "needs_reconcile" }
  | { kind: "async_recover"; jobId: string };

function isDupKeyError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: number }).code === 11000;
}

/**
 * Atomically claim the slot for (userId, key), or branch on the existing record.
 * `<E>` is the stored outcome envelope type (the run_service RunResultEnvelope).
 */
export async function claimRun<E>(userId: string, key: string): Promise<ClaimResult<E>> {
  const db = await getDb();
  const col = db.collection<RunIdempotencyDoc>(COLLECTIONS.runIdempotency);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  // Atomic claim: a unique _id makes a concurrent/retry insert fail → branch on the existing doc.
  try {
    await col.insertOne({ _id: id(userId, key), userId, key, state: "in_progress", leaseUntil, createdAt: now });
    return { kind: "fresh" };
  } catch (e) {
    if (!isDupKeyError(e)) throw e;
  }

  const doc = await col.findOne({ _id: id(userId, key) });
  if (!doc) return { kind: "fresh" }; // raced + TTL-expired between insert and read → treat as fresh

  if (doc.state === "settled") return { kind: "settled", outcome: doc.outcome as E };

  if (doc.state === "needs_reconcile") return { kind: "needs_reconcile" };

  if (doc.state === "settled_failure") {
    // Transient prior failure where nothing was paid → re-claim and retry (don't poison the key).
    const taken = await col.findOneAndUpdate(
      { _id: id(userId, key), state: "settled_failure" },
      { $set: { state: "in_progress", leaseUntil, createdAt: now }, $unset: { jobId: "", outcome: "" } },
    );
    if (taken) return { kind: "fresh" };
    // Someone else transitioned it first — re-read and branch conservatively.
    const after = await col.findOne({ _id: id(userId, key) });
    if (after?.state === "settled") return { kind: "settled", outcome: after.outcome as E };
    return { kind: "in_progress" };
  }

  // state === "in_progress"
  if (doc.leaseUntil.getTime() > now.getTime()) return { kind: "in_progress" }; // live lease → caller retries

  // EXPIRED lease — the worker died mid-flight.
  if (doc.jobId) return { kind: "async_recover", jobId: doc.jobId }; // async → re-poll (exactly-once)

  // Synchronous, unconfirmable → at-most-once: mark needs_reconcile, NEVER blind re-pay.
  await col.updateOne({ _id: id(userId, key) }, { $set: { state: "needs_reconcile" } });
  return { kind: "needs_reconcile" };
}

/** Persist the final outcome so a duplicate key returns it without re-charging. */
export async function settleRun<E>(userId: string, key: string, outcome: E, jobId?: string): Promise<void> {
  const db = await getDb();
  await db.collection<RunIdempotencyDoc>(COLLECTIONS.runIdempotency).updateOne(
    { _id: id(userId, key) },
    { $set: { state: "settled", outcome: outcome as unknown, settledAt: new Date(), ...(jobId ? { jobId } : {}) } },
  );
}

/** Mark a nothing-paid failure as retryable (a later call with the same key re-attempts). */
export async function failRun(userId: string, key: string): Promise<void> {
  const db = await getDb();
  await db.collection<RunIdempotencyDoc>(COLLECTIONS.runIdempotency).updateOne(
    { _id: id(userId, key) },
    { $set: { state: "settled_failure", failedAt: new Date() } },
  );
}

/**
 * Persist the provider jobId on the record BEFORE returning the job handle, so an expired-lease recovery
 * re-polls the existing job (exactly-once) instead of re-submitting. Also extends the lease.
 */
export async function markRunJob(userId: string, key: string, jobId: string): Promise<void> {
  const db = await getDb();
  await db.collection<RunIdempotencyDoc>(COLLECTIONS.runIdempotency).updateOne(
    { _id: id(userId, key) },
    { $set: { jobId, leaseUntil: new Date(Date.now() + LEASE_MS) } },
  );
}
