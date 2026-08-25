// Masterkey — user CRUD (server-only). Users are keyed by CDP embedded-wallet address.
// Identity (wallet + email) always comes from the validated CDP token (see src/lib/cdp.ts),
// never from client-sent values (Appendix R R3). See MCP_SPEC.md §5 + M1.

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { COLLECTIONS, type UserDoc } from "@/lib/mcp/types";
import { ensureIndexes } from "@/lib/mcp/indexes";

function nowISO(): string {
  return new Date().toISOString();
}

/** First day of next month, UTC — the next spend-period reset. */
export function firstOfNextMonthISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export function newUserId(): string {
  return `usr_${randomUUID().replace(/-/g, "")}`;
}

/** Default account state for a brand-new user (mirrors seedAccount() minus the hardcoded identity). */
export function seedDefaults(
  email: string | null,
): Pick<UserDoc, "profile" | "billing" | "spend"> {
  const name = email ? email.split("@")[0] : "";
  return {
    profile: { name, org: "Personal", plan: "Pay-as-you-go" },
    billing: {
      card: null,
      spentThisPeriodUsd: 0,
      periodResetsISO: firstOfNextMonthISO(),
      invoices: [],
    },
    spend: {
      monthlyLimitUsd: 50,
      advancedEnabled: false,
      perCallMaxUsd: null,
      rules: [],
      alerts: email
        ? [
            { id: "alert_20", pct: 20, email },
            { id: "alert_100", pct: 100, email },
          ]
        : [],
    },
  };
}

export async function getUser(id: string): Promise<UserDoc | null> {
  const db = await getDb();
  return db.collection<UserDoc>(COLLECTIONS.users).findOne({ _id: id });
}

export async function getUserByWallet(walletAddress: string): Promise<UserDoc | null> {
  const db = await getDb();
  return db
    .collection<UserDoc>(COLLECTIONS.users)
    .findOne({ walletAddress: walletAddress.toLowerCase() });
}

/**
 * Create-or-update a user keyed by wallet address, atomically (race-safe via the
 * unique walletAddress index + upsert). Seed defaults are applied only on insert.
 */
export async function upsertUserByWallet(input: {
  walletAddress: string;
  email: string | null;
  cdpUserId?: string;
  smartAccountAddress?: string | null;
  solanaAddress?: string | null;
}): Promise<UserDoc> {
  await ensureIndexes();
  const db = await getDb();
  const users = db.collection<UserDoc>(COLLECTIONS.users);
  const walletAddress = input.walletAddress.toLowerCase();

  const set: Partial<UserDoc> = { updatedISO: nowISO() };
  if (input.email !== undefined) set.email = input.email;
  if (input.cdpUserId) set.cdpUserId = input.cdpUserId;
  if (input.smartAccountAddress !== undefined)
    set.smartAccountAddress = input.smartAccountAddress;
  if (input.solanaAddress !== undefined) set.solanaAddress = input.solanaAddress;

  const result = await users.findOneAndUpdate(
    { walletAddress },
    {
      $set: set,
      $setOnInsert: {
        _id: newUserId(),
        ...seedDefaults(input.email),
        createdISO: nowISO(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  if (!result) {
    // Should not happen with returnDocument:"after" + upsert; refetch defensively.
    const doc = await users.findOne({ walletAddress });
    if (!doc) throw new Error("upsertUserByWallet failed to return a user");
    return doc;
  }
  return result;
}

export async function getSpendSettings(id: string): Promise<UserDoc["spend"] | null> {
  const u = await getUser(id);
  return u ? u.spend : null;
}

export async function updateSpendSettings(
  id: string,
  patch: Partial<UserDoc["spend"]>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedISO: nowISO() };
  for (const [k, v] of Object.entries(patch)) set[`spend.${k}`] = v;
  await db.collection<UserDoc>(COLLECTIONS.users).updateOne({ _id: id }, { $set: set });
}
