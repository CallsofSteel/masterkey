// Masterkey — OAuth data store (server-only). Clients (DCR), auth codes (PKCE), opaque tokens
// (hashed at rest, audience-bound), and connections. See MCP_SPEC.md M2 + Appendix R (R1 audience,
// R5 connection dedupe + revoke-by-connection).

import { randomUUID } from "crypto";
import type { RuleScope } from "@/lib/spend-buckets";
import { getDb } from "@/lib/db";
import {
  COLLECTIONS,
  type AuthCodeDoc,
  type ConnectionDoc,
  type OAuthClientDoc,
  type TokenDoc,
  type TokenEndpointAuthMethod,
} from "@/lib/mcp/types";
import { hashToken, randomToken } from "./crypto";
import { ACCESS_TOKEN_TTL_SEC, AUTH_CODE_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from "./config";

function nowISO() {
  return new Date().toISOString();
}

// ---- Clients (Dynamic Client Registration) ----

export async function createClient(input: {
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  scope?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}): Promise<{ client: OAuthClientDoc; clientSecret?: string }> {
  const db = await getDb();
  const method: TokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? "none";
  let clientSecret: string | undefined;
  let clientSecretHash: string | undefined;
  if (method === "client_secret_post") {
    clientSecret = randomToken(32);
    clientSecretHash = hashToken(clientSecret);
  }
  const client: OAuthClientDoc = {
    _id: `mkc_${randomUUID().replace(/-/g, "")}`,
    clientSecretHash,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes?.length ? input.grantTypes : ["authorization_code", "refresh_token"],
    responseTypes: input.responseTypes?.length ? input.responseTypes : ["code"],
    scope: input.scope,
    tokenEndpointAuthMethod: method,
    createdISO: nowISO(),
  };
  await db.collection<OAuthClientDoc>(COLLECTIONS.oauthClients).insertOne(client);
  return { client, clientSecret };
}

export async function getClient(clientId: string): Promise<OAuthClientDoc | null> {
  const db = await getDb();
  return db.collection<OAuthClientDoc>(COLLECTIONS.oauthClients).findOne({ _id: clientId });
}

export function verifyClientSecret(client: OAuthClientDoc, secret: string | null): boolean {
  if (client.tokenEndpointAuthMethod === "none") return true; // public client, PKCE-only
  if (!secret || !client.clientSecretHash) return false;
  return hashToken(secret) === client.clientSecretHash;
}

// ---- Connections (one per client+user; R5 dedupe) ----

export async function upsertConnection(input: {
  userId: string;
  clientId: string;
  name: string;
  scopes: RuleScope[];
}): Promise<ConnectionDoc> {
  const db = await getDb();
  const col = db.collection<ConnectionDoc>(COLLECTIONS.connections);
  const result = await col.findOneAndUpdate(
    { client: input.clientId, userId: input.userId },
    {
      $set: { name: input.name, scopes: input.scopes, status: "active", lastUsedISO: nowISO() },
      $setOnInsert: { _id: `conn_${randomUUID().replace(/-/g, "")}`, createdISO: nowISO() },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error("upsertConnection failed");
  return result;
}

export async function revokeConnection(userId: string, connectionId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<ConnectionDoc>(COLLECTIONS.connections)
    .updateOne({ _id: connectionId, userId }, { $set: { status: "revoked" } });
  await revokeConnectionTokens(connectionId);
}

export async function touchConnection(connectionId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<ConnectionDoc>(COLLECTIONS.connections)
    .updateOne({ _id: connectionId }, { $set: { lastUsedISO: nowISO() } });
}

// ---- Authorization codes (single-use, short TTL, PKCE) ----

export async function createAuthCode(input: {
  clientId: string;
  userId: string;
  connectionId: string;
  redirectUri: string;
  scope: string;
  audience: string;
  codeChallenge: string;
}): Promise<string> {
  const db = await getDb();
  const code = randomToken(32);
  const doc: AuthCodeDoc = {
    _id: code,
    clientId: input.clientId,
    userId: input.userId,
    connectionId: input.connectionId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    audience: input.audience,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000),
  };
  await db.collection<AuthCodeDoc>(COLLECTIONS.authCodes).insertOne(doc);
  return code;
}

/** Atomically consume (delete) an auth code so it can't be replayed. */
export async function consumeAuthCode(code: string): Promise<AuthCodeDoc | null> {
  const db = await getDb();
  const doc = await db.collection<AuthCodeDoc>(COLLECTIONS.authCodes).findOneAndDelete({ _id: code });
  if (!doc) return null;
  if (doc.expiresAt.getTime() < Date.now()) return null; // expired
  return doc;
}

// ---- Tokens (opaque, hashed at rest, audience-bound) ----

export async function issueTokens(input: {
  userId: string;
  clientId: string;
  connectionId: string;
  scope: string;
  audience: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const db = await getDb();
  const col = db.collection<TokenDoc>(COLLECTIONS.tokens);
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const base = {
    userId: input.userId,
    clientId: input.clientId,
    connectionId: input.connectionId,
    scope: input.scope,
    audience: input.audience,
    revoked: false,
    createdISO: nowISO(),
  };
  await col.insertMany([
    {
      _id: randomUUID(),
      type: "access",
      hashedToken: hashToken(accessToken),
      ...base,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000),
    },
    {
      _id: randomUUID(),
      type: "refresh",
      hashedToken: hashToken(refreshToken),
      ...base,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SEC };
}

/** Look up a valid (unrevoked, unexpired) token by raw value + type. */
export async function findValidToken(raw: string, type: "access" | "refresh"): Promise<TokenDoc | null> {
  const db = await getDb();
  const doc = await db
    .collection<TokenDoc>(COLLECTIONS.tokens)
    .findOne({ hashedToken: hashToken(raw), type, revoked: false });
  if (!doc) return null;
  if (doc.expiresAt.getTime() < Date.now()) return null;
  return doc;
}

/** Rotate a refresh token: revoke the old one, issue a fresh access+refresh pair. */
export async function rotateRefreshToken(
  raw: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string } | null> {
  const existing = await findValidToken(raw, "refresh");
  if (!existing) return null;
  // ensure the connection is still active
  const db = await getDb();
  const conn = await db
    .collection<ConnectionDoc>(COLLECTIONS.connections)
    .findOne({ _id: existing.connectionId, status: "active" });
  if (!conn) return null;
  await db
    .collection<TokenDoc>(COLLECTIONS.tokens)
    .updateOne({ _id: existing._id }, { $set: { revoked: true } });
  const issued = await issueTokens({
    userId: existing.userId,
    clientId: existing.clientId,
    connectionId: existing.connectionId,
    scope: existing.scope,
    audience: existing.audience,
  });
  return { ...issued, scope: existing.scope };
}

export async function revokeConnectionTokens(connectionId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<TokenDoc>(COLLECTIONS.tokens)
    .updateMany({ connectionId, revoked: false }, { $set: { revoked: true } });
}
