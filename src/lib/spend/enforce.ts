// Masterkey — spend enforcement (server-only). Runs BEFORE payment (reserve) and reconciles AFTER.
// Concurrency-safe via atomic monthly reservation (reserveMonthly) + reconcile on settle/release.
// See MCP_SPEC.md M5 + Appendix R5 (reserve-before-pay) / R6 (typed reject reasons).

import { bucketForCategory, type BucketKey } from "@/lib/spend-buckets";
import { getUser } from "@/lib/users";
import { getDb } from "@/lib/db";
import { COLLECTIONS, type ConnectionDoc, type LedgerStatus, type RejectReason } from "@/lib/mcp/types";
import {
  appendLedger,
  incSpent,
  reserveMonthly,
  resetPeriodIfDue,
  settledForConnection,
  settledSince,
} from "./ledger";

function defaultCeiling(): number {
  const v = Number(process.env.MASTERKEY_DEFAULT_PRICE_CEILING_USD || "1");
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Estimate a call's cost: known amount → range max → per-call max → global ceiling (R5 order). */
export function estimateCost(
  price: { amount: number | null; max?: number | null },
  perCallMaxUsd: number | null,
): number {
  return price.amount ?? price.max ?? perCallMaxUsd ?? defaultCeiling();
}

function startOfDayUTC(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfMonthUTC(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export type ReserveResult =
  | { allow: true; maxValueUsd: number; estCostUsd: number; reservedUsd: number; bucket: BucketKey }
  | { allow: false; reason: RejectReason; message: string; bucket: BucketKey };

/** Common ledger identity fields for a call. */
export type CallRef = {
  userId: string;
  connectionId: string;
  tokenJti?: string;
  serviceId: string;
  serviceName: string; // human-readable line item (service + provider); persisted on every ledger row
  operation?: string;
  provider: string;
  backendUrl: string;
  bucket: BucketKey | "all";
  runId?: string; // web-run association (idempotencyKey prefix) → ledger row tag for cost derivation
};

/**
 * Check limits and atomically reserve the estimated cost against the monthly limit.
 * Returns the wallet ceiling (maxValueUsd) on allow, or a typed reason on reject.
 */
export async function reserveSpend(args: {
  userId: string;
  connectionId: string;
  category: string;
  estCostUsd: number;
}): Promise<ReserveResult> {
  const bucket = bucketForCategory(args.category);
  const db = await getDb();

  let user = await getUser(args.userId);
  if (!user) return { allow: false, reason: "scope", message: "user not found", bucket };
  user = await resetPeriodIfDue(user);

  const conn = await db
    .collection<ConnectionDoc>(COLLECTIONS.connections)
    .findOne({ _id: args.connectionId });

  // Connection scope: must be active and authorized for this bucket (or "all").
  const scopes = conn?.scopes ?? [];
  if (conn?.status !== "active" || (!scopes.includes("all") && !scopes.includes(bucket))) {
    return { allow: false, reason: "scope", message: `connection not authorized for ${bucket}`, bucket };
  }

  const est = args.estCostUsd;
  const { perCallMaxUsd, monthlyLimitUsd, advancedEnabled, rules } = user.spend;

  // Per-call max.
  if (perCallMaxUsd != null && est > perCallMaxUsd) {
    return {
      allow: false,
      reason: "per_call_max",
      message: `estimated $${est} exceeds per-call max $${perCallMaxUsd}`,
      bucket,
    };
  }

  // maxValue ceilings to combine (spec: min(perCallMax ?? ceiling, monthlyRemaining, rule remainings)).
  const caps: number[] = [perCallMaxUsd ?? defaultCeiling()];

  // Advanced rules.
  if (advancedEnabled) {
    for (const r of rules) {
      if (!r.enabled) continue;
      if (r.scope !== "all" && r.scope !== bucket) continue;
      const scopeBucket = r.scope === "all" ? undefined : (r.scope as BucketKey);
      let spent = 0;
      if (r.period === "per-day") spent = await settledSince(args.userId, startOfDayUTC(), { bucket: scopeBucket });
      else if (r.period === "per-month") spent = await settledSince(args.userId, startOfMonthUTC(), { bucket: scopeBucket });
      else if (r.period === "per-session") spent = await settledForConnection(args.connectionId, scopeBucket);
      // per-call: spent stays 0 (just compares est to cap)
      const remaining = r.capUsd - spent;
      if (est > remaining) {
        return {
          allow: false,
          reason: "rule",
          message: `exceeds ${r.period} cap $${r.capUsd} for ${r.scope}`,
          bucket,
        };
      }
      caps.push(remaining);
    }
  }

  caps.push(monthlyLimitUsd - user.billing.spentThisPeriodUsd);

  // Atomic monthly reservation (concurrency-safe).
  const reserved = await reserveMonthly(args.userId, est, monthlyLimitUsd);
  if (!reserved) {
    return { allow: false, reason: "monthly_limit", message: `would exceed monthly limit $${monthlyLimitUsd}`, bucket };
  }

  const maxValueUsd = Math.max(0, Math.min(...caps.filter((c) => Number.isFinite(c))));
  return { allow: true, maxValueUsd, estCostUsd: est, reservedUsd: est, bucket };
}

/**
 * After a payment attempt: reconcile the reservation + record the ledger row.
 *
 * RUN_RELIABILITY_SPEC 1.4: only a CONFIRMED charge (verifiable settlement — `confirmed` from the
 * wallet AND a real tx hash) is booked `settled` and counted in spend. A paid-but-unconfirmed charge
 * (Sponge reported payment but we have no verifiable tx) is booked `unconfirmed`, the reservation is
 * RELEASED (not counted), and the reconciler (2.5) later promotes it to settled (+incSpent) or voids
 * it — so we never inflate spend with a charge we can't tie to a real on-chain settlement.
 */
export async function settleSpend(
  ref: CallRef,
  args: {
    reservedUsd: number;
    actualCostUsd: number;
    network: string;
    txHash?: string;
    confirmed?: boolean;
    /** Provider's x402 recipient for this call — persisted so the reconciler can bind a hashless row to a
     *  tx that actually paid THIS provider (not another provider's same-amount settlement). */
    payTo?: string;
  },
): Promise<void> {
  const wantSettled = args.confirmed !== false && !!args.txHash;
  // Append FIRST: appendLedger may downgrade settled→unconfirmed (no hash / duplicate hash, 1.4/1.5).
  // incSpent then follows the status ACTUALLY written, so spend never diverges from the ledger row.
  const written = await appendLedger({
    ...ref,
    costUsd: args.actualCostUsd,
    network: args.network,
    txHash: args.txHash,
    payTo: args.payTo,
    status: wantSettled ? "settled" : "unconfirmed",
  });
  if (written === "settled") {
    await incSpent(ref.userId, args.actualCostUsd - args.reservedUsd);
  } else {
    await incSpent(ref.userId, -args.reservedUsd); // release the reservation — don't count unconfirmed spend
  }
}

/** After a failed payment (post-reservation): release the reservation + record. */
export async function releaseReservation(
  ref: CallRef,
  args: { reservedUsd: number; status: Extract<LedgerStatus, "failed">; network?: string },
): Promise<void> {
  await incSpent(ref.userId, -args.reservedUsd);
  await appendLedger({ ...ref, costUsd: 0, network: args.network ?? "", status: args.status });
}

/** Pre-payment rejection (no reservation was made): record for observability. */
export async function recordRejected(ref: CallRef, reason: RejectReason): Promise<void> {
  await appendLedger({ ...ref, costUsd: 0, network: "", status: "rejected", rejectedReason: reason });
}
