// Sign-in can OPTIONALLY be restricted to one or more email domains via the
// NEXT_PUBLIC_SIGNIN_ALLOWLIST env var (comma-separated; the leading "@" is
// optional), e.g. "@coinbase.com" or "coinbase.com,example.org".
//
// - Set    → only emails in those domains may sign in (this is how masterkey.sh
//            keeps itself to its intended audience).
// - Unset/blank → ANY email may sign in. This is the default, so anyone who
//            forks/self-hosts this repo is NOT blocked by anything.
//
// The allowlist is NOT a secret (it is shown in the sign-in dialog), so it is a
// NEXT_PUBLIC_ var readable by both the client (for UX) and the server. The
// AUTHORITATIVE enforcement is server-side in /api/auth/check, where the email is
// derived from the validated CDP access token (never from client input) — so it
// cannot be spoofed by editing the request in devtools. The sign-in dialog only
// mirrors this check for UX. Shared here so the two never drift.

/**
 * The configured allowed email domains, lowercased and with any leading "@"
 * stripped. An empty array means "no restriction — any email may sign in".
 */
export function allowedEmailDomains(): string[] {
  const raw = process.env.NEXT_PUBLIC_SIGNIN_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** True when an allowlist is configured (sign-in is domain-restricted). */
export function isSignInRestricted(): boolean {
  return allowedEmailDomains().length > 0;
}

/**
 * True if `email` may sign in.
 *
 * When no allowlist is configured, EVERY email is allowed. Otherwise the email's
 * domain must EXACTLY match one of the allowlisted domains — we split on the LAST
 * "@", so subdomains (`x@corp.coinbase.com`) and look-alikes
 * (`x@coinbase.com.evil.com`) are rejected.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const domains = allowedEmailDomains();
  if (domains.length === 0) return true; // no restriction configured
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domains.includes(domain);
}
