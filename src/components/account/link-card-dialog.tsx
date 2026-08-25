"use client";

import { useState } from "react";
import Image from "next/image";
import { Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccount } from "@/lib/account";

// The Stripe Link badge (mock — purely cosmetic).
function StripeLinkMark() {
  return (
    <span className="inline-flex items-center gap-1 font-semibold">
      <Image src="/logos/link.png" alt="" width={16} height={16} className="rounded-full" aria-hidden />
      Link
    </span>
  );
}

function detectCard(num: string): { brand: string; last4: string } {
  const digits = num.replace(/\D/g, "");
  const last4 = digits.slice(-4).padStart(4, "•");
  let brand = "Card";
  if (/^4/.test(digits)) brand = "Visa";
  else if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) brand = "Mastercard";
  else if (/^3[47]/.test(digits)) brand = "Amex";
  else if (/^6/.test(digits)) brand = "Discover";
  return { brand, last4 };
}

/**
 * Mock "Link by Stripe" flow. No real card is stored or charged — on submit we record only
 * { brand, last4 } in the local account store.
 */
export function LinkCardButton({
  variant = "default",
  size = "default",
  label,
  className,
}: {
  variant?: "default" | "outline" | "secondary";
  size?: "default" | "sm" | "lg";
  label?: React.ReactNode;
  className?: string;
}) {
  const { linkCard } = useAccount();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [exp, setExp] = useState("");
  const [cvc, setCvc] = useState("");

  function reset() {
    setNumber("");
    setExp("");
    setCvc("");
  }

  function submit() {
    const digits = number.replace(/\D/g, "");
    const { brand, last4 } = detectCard(digits || "4242424242424242");
    linkCard({ brand, last4 });
    setOpen(false);
    reset();
  }

  const valid = number.replace(/\D/g, "").length >= 12 && exp.length >= 4 && cvc.length >= 3;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          {label ?? (
            <>
             <StripeLinkMark />
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Link a card with <StripeLinkMark />
          </DialogTitle>
          <DialogDescription>
            Your card is the payment method for pay-per-use calls. You&apos;re only charged for what you use.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="card-number">Card number</Label>
            <Input
              id="card-number"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              placeholder="4242 4242 4242 4242"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="card-exp">Expiry</Label>
              <Input
                id="card-exp"
                inputMode="numeric"
                placeholder="12 / 28"
                value={exp}
                onChange={(e) => setExp(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-cvc">CVC</Label>
              <Input
                id="card-cvc"
                inputMode="numeric"
                placeholder="123"
                value={cvc}
                onChange={(e) => setCvc(e.target.value)}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setNumber("4242 4242 4242 4242");
              setExp("12 / 28");
              setCvc("123");
            }}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Use a test card
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid}>
            <Check className="size-4" />
            Link card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
