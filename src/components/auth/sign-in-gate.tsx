"use client";

// Masterkey — reusable sign-in gate (W1). Wraps the existing CDP SignInDialog + AccountProvider so
// any client surface can require sign-in without re-implementing the flow. The Composer uses
// `ensureSignedIn()` to gate "Run it" (preserving the draft — the dialog overlays, never unmounts the
// caller), and protected pages (/run, /library) use `signedIn`/`loading` to redirect anonymous users.
// See MCP_SPEC.md M1.

import { useCallback, useState } from "react";
import { useAccount } from "@/lib/account";

export interface SignInGate {
  signedIn: boolean;
  /** First account-load attempt is still in flight (avoid flashing a redirect before auth resolves). */
  loading: boolean;
  /** If signed in, returns true; otherwise opens the sign-in dialog and returns false. */
  ensureSignedIn: () => boolean;
  /** Open the sign-in dialog directly. */
  openSignIn: () => void;
  /** Spread onto <SignInDialog {...dialogProps} />. */
  dialogProps: { open: boolean; onOpenChange: (open: boolean) => void };
}

export function useSignInGate(): SignInGate {
  const { signedIn, loading } = useAccount();
  const [open, setOpen] = useState(false);

  const ensureSignedIn = useCallback((): boolean => {
    if (signedIn) return true;
    setOpen(true);
    return false;
  }, [signedIn]);

  const openSignIn = useCallback(() => setOpen(true), []);

  return {
    signedIn,
    loading,
    ensureSignedIn,
    openSignIn,
    dialogProps: { open, onOpenChange: setOpen },
  };
}
