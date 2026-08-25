// Masterkey — Coinbase CDP server client (server-only). Validates the CDP embedded-wallet
// access token server-side so we can trust *which* user is acting, and derives the user's
// wallet address + email FROM THE VALIDATED TOKEN (never from client-sent values).
//
// See MCP_SPEC.md M0/M1 + Appendix R R3. Requires CDP_API_KEY_ID / CDP_API_KEY_SECRET.

import { CdpClient } from "@coinbase/cdp-sdk";

declare global {
  var _mkCdpClient: CdpClient | undefined;
}

function cdp(): CdpClient {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    throw new Error("CDP_API_KEY_ID / CDP_API_KEY_SECRET not set");
  }
  if (!globalThis._mkCdpClient) {
    globalThis._mkCdpClient = new CdpClient({ apiKeyId, apiKeySecret });
  }
  return globalThis._mkCdpClient;
}

/** The validated end-user object returned by the CDP SDK. */
export type CdpEndUser = Awaited<
  ReturnType<CdpClient["endUser"]["validateAccessToken"]>
>;

/** A single CDP authentication method (the typed union from the SDK). */
type CdpAuthMethod = CdpEndUser["authenticationMethods"][number];

/** The trusted identity we persist, derived server-side from the validated token. */
export type CdpIdentity = {
  cdpUserId: string;
  /** Lowercased EVM EOA address (evmAccountObjects[0]) — the canonical user key. */
  walletAddress: string | null;
  /**
   * Lowercased EVM smart-account address, if one is provisioned. With
   * ethereum.createOnLogin="eoa" this is null today; captured so a future
   * EIP-7702 upgrade / smart-account switch doesn't lose data. See x402.md.
   */
  smartAccountAddress: string | null;
  /** Base58 Solana address (case-sensitive — never lowercased), if provisioned. */
  solanaAddress: string | null;
  email: string | null;
};

/** Pull an email off an auth method if it carries one (email + OAuth2 methods do). */
function methodEmail(m: CdpAuthMethod): string | undefined {
  return "email" in m ? m.email : undefined;
}

/**
 * Validate a CDP embedded-wallet access token server-side.
 * Throws if the token is missing, invalid, or expired.
 */
export async function validateCdpAccessToken(
  accessToken: string,
): Promise<CdpEndUser> {
  if (!accessToken) throw new Error("missing accessToken");
  return cdp().endUser.validateAccessToken({ accessToken });
}

/**
 * Derive the trusted identity (wallet + email) from a validated endUser.
 * Reads the non-deprecated *Objects fields (evmAccountObjects / evmSmartAccountObjects /
 * solanaAccountObjects); falls back to the deprecated evmAccounts only if needed.
 * Email lives inside authenticationMethods (EmailAuthentication.email, or an
 * OAuth2 provider's optional email) — it is not a top-level field.
 */
export function extractIdentity(endUser: CdpEndUser): CdpIdentity {
  const eoa =
    endUser.evmAccountObjects?.[0]?.address ?? endUser.evmAccounts?.[0] ?? null;
  const smart = endUser.evmSmartAccountObjects?.[0]?.address ?? null;
  const solana = endUser.solanaAccountObjects?.[0]?.address ?? null;

  const methods = endUser.authenticationMethods ?? [];
  // Prefer the dedicated email method; fall back to any method carrying an email (e.g. Google).
  const email =
    methods
      .filter((m) => m.type === "email")
      .map(methodEmail)
      .find((e) => !!e) ??
    methods.map(methodEmail).find((e) => !!e) ??
    null;

  return {
    cdpUserId: endUser.userId,
    walletAddress: eoa ? eoa.toLowerCase() : null,
    smartAccountAddress: smart ? smart.toLowerCase() : null,
    solanaAddress: solana, // base58 — case-sensitive
    email,
  };
}
