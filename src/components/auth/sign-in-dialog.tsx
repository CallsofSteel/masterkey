"use client";

// Masterkey — sign-in modal. Built on @coinbase/cdp-hooks (email OTP) since cdp-react is
// omitted (react peer cap). On success, AccountProvider (src/lib/account.tsx) establishes the
// first-party server session (/api/auth/check) when CDP's isSignedIn flips true — this dialog
// only drives the CDP sign-in itself. See MCP_SPEC.md M1.
//
// Sign-in can be restricted to specific email domains via NEXT_PUBLIC_SIGNIN_ALLOWLIST
// (see src/lib/auth-domain.ts). When a restriction is configured, we block a
// non-allowlisted email BEFORE calling CDP, so a normal user never triggers an OTP
// send. That check is UX only — the real, unbypassable gate is server-side in
// /api/auth/check. When no allowlist is set, any email may sign in. Google OAuth is
// removed because it would let any Google account reach CDP sign-in bypassing the gate.

import { useState, type FormEvent } from "react";
import { useSignInWithEmail, useVerifyEmailOTP } from "@coinbase/cdp-hooks";
import { isAllowedEmail, allowedEmailDomains, isSignInRestricted } from "@/lib/auth-domain";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { signInWithEmail } = useSignInWithEmail();
  const { verifyEmailOTP } = useVerifyEmailOTP();

  // Optional email-domain allowlist (empty ⇒ any email may sign in).
  const restricted = isSignInRestricted();
  const domains = allowedEmailDomains();
  const primaryDomain = domains[0];
  const domainList = domains.map((d) => `@${d}`).join(", ");

  const [phase, setPhase] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPhase("email");
    setFlowId(null);
    setOtp("");
    setError(null);
    setBusy(false);
  }

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    // If an allowlist is configured, don't even ask CDP to send an OTP to a
    // non-allowlisted address. (Authoritative enforcement is still server-side in
    // /api/auth/check.) With no allowlist, isAllowedEmail() is always true.
    if (!isAllowedEmail(email)) {
      setError(`Sign-in is restricted to ${domainList} email addresses.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { flowId: id } = await signInWithEmail({ email: email.trim() });
      setFlowId(id);
      setPhase("otp");
    } catch {
      setError("Couldn't send the code. Check the email and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!flowId) return;
    setBusy(true);
    setError(null);
    try {
      await verifyEmailOTP({ flowId, otp: otp.trim() });
      // CDP is now signed in; AccountProvider establishes the mk_session server session
      // when isSignedIn flips true (see src/lib/account.tsx).
      onOpenChange(false);
      reset();
    } catch {
      setError("Invalid or expired code.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to Masterkey</DialogTitle>
          <DialogDescription>
            {phase === "email"
              ? restricted
                ? `Sign in with your ${primaryDomain ? `@${primaryDomain}` : "allowlisted"} email.`
                : "Sign in with your email to continue."
              : `Enter the 6-digit code sent to ${email}.`}
          </DialogDescription>
        </DialogHeader>

        {phase === "email" ? (
          <form onSubmit={sendCode} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mk-email">Email</Label>
              <Input
                id="mk-email"
                type="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={`you@${primaryDomain ?? "example.com"}`}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Continue with email"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mk-otp">Verification code</Label>
              <Input
                id="mk-otp"
                inputMode="numeric"
                autoFocus
                required
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || otp.length !== 6}>
              {busy ? "Verifying…" : "Verify & sign in"}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={reset}>
              Use a different email
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
