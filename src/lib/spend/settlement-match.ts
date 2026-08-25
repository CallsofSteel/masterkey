// Masterkey — pure settlement-matching predicates (RUN_RELIABILITY_SPEC 0.2 follow-up).
//
// Deliberately dependency-free (no wallet / db / network / SDK imports), mirroring `mcp/async-detect.ts`,
// so the rules that decide "does this on-chain transaction belong to this charge?" can be tested in
// isolation without spending money or touching a chain.
//
// WHY these exist: matching a charge to a settlement on AMOUNT + CHAIN alone cannot tell two providers
// apart. Sponge can report `payment_made:true` for a call that never settled on-chain (0.2, confirmed
// 2026-07-26 against StableStudio). If such a charge coexists with a genuine same-amount charge to a
// DIFFERENT provider, amount-only matching lets the phantom claim the real transaction: the RPC receipt is
// valid, the amount agrees, and it gets promoted to `settled`. The recipient is the discriminator.

/**
 * Compare two payment recipient addresses.
 *
 * EVM hex is case-insensitive (EIP-55 mixed case is a checksum, not identity), so `0x`-prefixed values
 * compare case-insensitively. Solana base58 IS case-sensitive — `7xKX…` and `7XkX…` are different
 * accounts — so non-hex values are only ever compared exactly. Returns false when either side is unknown;
 * callers decide whether "unknown" means skip-the-check or reject.
 */
export function sameAddress(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith("0x") && b.startsWith("0x") && a.toLowerCase() === b.toLowerCase();
}

/** The recipient of a wallet-history transaction row, across Sponge's field-name variants. */
export function txRecipient(t: Record<string, unknown>): string | undefined {
  for (const k of ["to", "recipient", "destination", "toAddress"]) {
    const v = t[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * An ERC-20 Transfer log's indexed address topic (32-byte left-padded) → a plain lowercase `0x…` address.
 * `topics[1]` is `from`, `topics[2]` is `to`.
 */
export function topicToAddress(topic: string | undefined): string | undefined {
  if (!topic || topic.length < 40) return undefined;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Should a candidate transaction be considered for THIS charge, given the provider we expected to pay?
 *
 * `expectedPayTo` is optional by design: rows written before payTo was persisted (and targets whose
 * registry entry carries no payTo for the chosen chain) fall back to amount+chain matching, i.e. exactly
 * the previous behavior. When it IS known, a mismatch is disqualifying.
 */
export function recipientAllows(candidate: Record<string, unknown>, expectedPayTo?: string): boolean {
  if (!expectedPayTo) return true;
  return sameAddress(txRecipient(candidate), expectedPayTo);
}
