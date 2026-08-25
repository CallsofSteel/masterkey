"use client";

// Masterkey — sign-in gate for the OAuth consent screen. When the resource owner isn't signed in,
// prompt CDP sign-in; once the first-party session is established, refresh so the server page can
// read it and render the consent screen. See MCP_SPEC.md M2.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "@/lib/account";
import { Button } from "@/components/ui/button";
import { SignInDialog } from "@/components/auth/sign-in-dialog";

export function SignInGate() {
  const { signedIn, hydrated } = useAccount();
  const [open, setOpen] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if (hydrated && signedIn) router.refresh();
  }, [hydrated, signedIn, router]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="font-heading text-2xl text-foreground">Sign in to continue</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        An application is requesting access to your Masterkey account. Sign in to review and approve it.
      </p>
      <Button onClick={() => setOpen(true)}>Sign in</Button>
      <SignInDialog open={open} onOpenChange={setOpen} />
    </main>
  );
}
