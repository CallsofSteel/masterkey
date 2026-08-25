"use client";

import Link from "next/link";
import { useState } from "react";
import { CreditCard, SlidersHorizontal, Plug, LogOut, Library, Boxes } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { UserAvatar } from "@/components/account/user-avatar";
import { useAccount, fmtUsd, pctUsed } from "@/lib/account";
import { SignInDialog } from "@/components/auth/sign-in-dialog";

const LINKS = [
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/limits", label: "Spend limits", icon: SlidersHorizontal },
  { href: "/dashboard/connections", label: "Connections", icon: Plug },
];

export function AccountMenu() {
  const { account, hydrated, signedIn, signOut } = useAccount();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const { user, billing, spend } = account;
  const pct = pctUsed(account);

  // Anonymous: show a Sign in button that opens the CDP sign-in modal.
  if (hydrated && !signedIn) {
    return (
      <>
        <Button size="sm" onClick={() => setSignInOpen(true)}>
          Sign in
        </Button>
        <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex shrink-0 items-center gap-2 rounded-full p-0.5 pr-2 transition-colors hover:bg-accent cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
            aria-label="Account menu"
          >
            <UserAvatar name={user.name} src={user.avatarUrl} />
            <span className="hidden text-sm font-medium text-foreground sm:block">{user.name.split(" ")[0]}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-72 border border-border shadow-2xl ring-foreground/15"
        >
          <div className="min-w-0 px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>

          <DropdownMenuSeparator />

          {/* Spend this period vs monthly limit (live from the store). */}
          <div className="px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Spent this period</span>
              <span className="font-medium tabular-nums text-foreground">
                {hydrated ? `${fmtUsd(billing.spentThisPeriodUsd)} / ${fmtUsd(spend.monthlyLimitUsd)}` : "—"}
              </span>
            </div>
            <Progress value={pct} className="h-1.5 bg-secondary" aria-label="Monthly spend usage" />
            <p className="mt-1 text-xs text-muted-foreground">
              {billing.card ? `${billing.card.brand} ending ${billing.card.last4}` : "No card linked"}
            </p>
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <Link href="/bundles">
              <Boxes className="text-muted-foreground" />
              Bundles
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/library">
              <Library className="text-muted-foreground" />
              Library
            </Link>
          </DropdownMenuItem>
          {LINKS.map((l) => (
            <DropdownMenuItem key={l.href} asChild>
              <Link href={l.href}>
                <l.icon className="text-muted-foreground" />
                {l.label}
              </Link>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setConfirmLogout(true);
            }}
          >
            <LogOut className="text-muted-foreground" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Log out?</DialogTitle>
            <DialogDescription>
              You&apos;ll be signed out of Masterkey on this browser.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLogout(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void signOut();
                setConfirmLogout(false);
              }}
            >
              Log out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
