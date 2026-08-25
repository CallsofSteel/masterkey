"use client";

// Masterkey — client provider tree. Wraps the app with the CDP embedded-wallet provider
// (login/identity) and the account store. We use @coinbase/cdp-hooks' CDPHooksProvider
// (not cdp-react, which is omitted due to its react <19.2.0 peer cap) and build the
// sign-in UI ourselves with hooks + shadcn. See MCP_SPEC.md M1.

import { CDPHooksProvider } from "@coinbase/cdp-hooks";
import type { ReactNode } from "react";
import { AccountProvider } from "@/lib/account";
import { ThemeProvider } from "@/lib/theme";

const cdpConfig = {
  projectId: process.env.NEXT_PUBLIC_CDP_PROJECT_ID ?? "",
  // EOA for now (identity = EVM EOA address); upgrade to smart-account features
  // (spend permissions / gas sponsorship for seamless x402) via EIP-7702 later.
  ethereum: { createOnLogin: "eoa" as const },
  // Provision a Solana account at login too — cross-chain (Solana x402) is on the
  // roadmap, and creating it now avoids per-user retrofit friction later.
  solana: { createOnLogin: true },
};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <CDPHooksProvider config={cdpConfig}>
        <AccountProvider>{children}</AccountProvider>
      </CDPHooksProvider>
    </ThemeProvider>
  );
}
