// Masterkey — server-side assembly of the dashboard `Account` shape from Mongo (UserDoc +
// ConnectionDoc[]), plus patch helpers. The dashboard's Account TS shape (src/lib/account.tsx)
// is preserved; only the persistence moves here. See MCP_SPEC.md M1.

import { getDb } from "@/lib/db";
import { getUser, updateSpendSettings } from "@/lib/users";
import { COLLECTIONS, type ConnectionDoc, type UserDoc } from "@/lib/mcp/types";
import type { Account, Connection } from "@/lib/account";

function nowISO(): string {
  return new Date().toISOString();
}

function toConnection(c: ConnectionDoc): Connection {
  // Real OAuth connections don't expose tokens (Appendix R6). tokenPrefix/last4 are display-only
  // remnants of the mock; kept to satisfy the existing dashboard type until the M2/M9 rework.
  return {
    id: c._id,
    name: c.name,
    client: c.client,
    scopes: c.scopes,
    tokenPrefix: "mk_agent",
    last4: "",
    createdISO: c.createdISO,
    lastUsedISO: c.lastUsedISO,
    status: "active",
  };
}

/** Map a UserDoc (+ its active connections) into the dashboard Account shape. */
export function assembleAccount(user: UserDoc, connections: ConnectionDoc[]): Account {
  return {
    user: {
      name: user.profile.name,
      email: user.email ?? "",
      avatarUrl: user.profile.avatarUrl,
      org: user.profile.org,
      plan: user.profile.plan,
    },
    billing: {
      card: user.billing.card,
      spentThisPeriodUsd: user.billing.spentThisPeriodUsd,
      periodResetsISO: user.billing.periodResetsISO,
      invoices: user.billing.invoices,
    },
    spend: {
      monthlyLimitUsd: user.spend.monthlyLimitUsd,
      advancedEnabled: user.spend.advancedEnabled,
      perCallMaxUsd: user.spend.perCallMaxUsd,
      rules: user.spend.rules,
      alerts: user.spend.alerts,
    },
    connections: connections.map(toConnection),
  };
}

/** Full Account for a user, or null if the user doesn't exist. */
export async function getAccountForUser(userId: string): Promise<Account | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const db = await getDb();
  const connections = await db
    .collection<ConnectionDoc>(COLLECTIONS.connections)
    .find({ userId, status: "active" })
    .sort({ createdISO: -1 })
    .toArray();
  return assembleAccount(user, connections);
}

export type AccountPatch = {
  profile?: Partial<UserDoc["profile"]> & { email?: string };
  spend?: Partial<UserDoc["spend"]>;
  card?: UserDoc["billing"]["card"]; // null to unlink, or { brand, last4, linkedISO }
};

/** Apply a partial update to a user's profile / spend / card. Spend is enforcement source-of-truth. */
export async function applyAccountPatch(userId: string, patch: AccountPatch): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedISO: nowISO() };

  if (patch.profile) {
    const { email, ...profile } = patch.profile;
    for (const [k, v] of Object.entries(profile)) set[`profile.${k}`] = v;
    if (email !== undefined) set.email = email;
  }
  if (patch.card !== undefined) set["billing.card"] = patch.card;
  if (Object.keys(set).length > 1) {
    await db.collection<UserDoc>(COLLECTIONS.users).updateOne({ _id: userId }, { $set: set });
  }

  // Spend goes through the dedicated helper (dot-path $set), whitelisted to user-editable keys.
  // Never let the client write billing.spentThisPeriodUsd — that is ledger-derived only.
  if (patch.spend) {
    const allowed: (keyof UserDoc["spend"])[] = [
      "monthlyLimitUsd",
      "advancedEnabled",
      "perCallMaxUsd",
      "rules",
      "alerts",
    ];
    const spend: Partial<UserDoc["spend"]> = {};
    for (const k of allowed) {
      if (patch.spend[k] !== undefined) (spend as Record<string, unknown>)[k] = patch.spend[k];
    }
    if (Object.keys(spend).length) await updateSpendSettings(userId, spend);
  }
}
