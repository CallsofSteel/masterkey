"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowLeft, CreditCard, SlidersHorizontal, Plug, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccount } from "@/lib/account";
import { UserAvatar } from "@/components/account/user-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SignInDialog } from "@/components/auth/sign-in-dialog";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/limits", label: "Spend limits", icon: SlidersHorizontal },
  { href: "/dashboard/connections", label: "Connections", icon: Plug },
];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { account, hydrated, signedIn, signOut } = useAccount();
  const [signInOpen, setSignInOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  // Until auth resolves, show a minimal placeholder (avoid flashing the gate).
  if (!hydrated) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // Anonymous → prompt sign-in instead of rendering the dashboard.
  if (!signedIn) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <Image src="/logo.png" alt="Masterkey" width={40} height={40} className="rounded-lg" priority />
        <div>
          <h1 className="font-heading text-2xl text-foreground">Sign in to Masterkey</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your billing, spend limits, and connections live in your account.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setSignInOpen(true)}>Sign in</Button>
          <Button variant="outline" asChild>
            <Link href="/">Back to catalog</Link>
          </Button>
        </div>
        <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh bg-background">
      {/* Desktop settings sidebar */}
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          {/* Wordmark styling matches the catalog sidebar footer (LogoThemeToggle's label). */}
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="Masterkey" width={32} height={32} className="rounded-lg" priority />
            <span className="font-heading text-lg italic leading-none text-foreground">Masterkey</span>
          </Link>
        </div>

        <div className="px-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to catalog
          </Link>
        </div>

        <nav className="mt-3 flex flex-col gap-0.5 px-3">
          <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p>
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} active={isActive(n.href)} />
          ))}
        </nav>

        <div className="mt-auto border-t border-border p-3">
          <button
            type="button"
            onClick={() => setConfirmLogout(true)}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="size-4 shrink-0" />
            Log out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar + horizontal nav */}
        <div className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-sm text-muted-foreground">
              <ArrowLeft className="size-4" />
              Catalog
            </Link>
            <UserAvatar name={account.user.name} src={account.user.avatarUrl} className="size-7" />
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-3 py-2">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors",
                  isActive(n.href) ? "bg-secondary font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>

        <main className="mx-auto w-full max-w-3xl px-4 py-8 lg:px-8 lg:py-10">{children}</main>
      </div>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Log out?</DialogTitle>
            <DialogDescription>You&apos;ll be signed out of Masterkey on this browser.</DialogDescription>
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
    </div>
  );
}
