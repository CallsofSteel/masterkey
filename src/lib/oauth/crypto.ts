// Masterkey — OAuth crypto helpers (server-only). Opaque tokens; only their hashes are stored.
// PKCE S256 per RFC 7636. See MCP_SPEC.md M2.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** A high-entropy opaque token / code string. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** Hash a raw token for at-rest storage (never store the raw token). */
export function hashToken(token: string): string {
  return b64url(sha256(token));
}

/** Verify a PKCE code_verifier against a stored S256 code_challenge (constant-time). */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = Buffer.from(b64url(sha256(verifier)));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
