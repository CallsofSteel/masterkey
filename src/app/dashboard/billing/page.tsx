"use client";

import Link from "next/link";
import { CreditCard, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LinkCardButton } from "@/components/account/link-card-dialog";
import { useAccount, fmtUsd, fmtDate, pctUsed } from "@/lib/account";
import { PageHeader, SectionCard, InfoRow } from "../_components/ui";

export default function BillingPage() {
  const { account, hydrated, unlinkCard } = useAccount();
  const { billing, spend } = account;
  const pct = pctUsed(account);

  return (
    <>
      <PageHeader
        title="Billing"
        description="Pay-per-use, billed to your card. There's no prepaid balance — you're charged for what you use, up to your spend limits."
      />

      <div className="space-y-5">
        {/* Spend this period — read-only usage against the monthly limit. */}
        <SectionCard
          title="This period"
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/limits">
                Spend limits
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          }
        >
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="font-heading text-4xl font-normal tabular-nums text-foreground">
                {hydrated ? fmtUsd(billing.spentThisPeriodUsd) : "—"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                spent of {fmtUsd(spend.monthlyLimitUsd)} monthly limit
              </p>
            </div>
            <span className="text-sm font-medium tabular-nums text-muted-foreground">{pct}% used</span>
          </div>
          <Progress value={pct} className="mt-3" />
          <p className="mt-2 text-xs text-muted-foreground">Resets {fmtDate(billing.periodResetsISO)}</p>
        </SectionCard>

        {/* Payment method — mock Stripe Link. */}
        <SectionCard
          title="Payment method"
          description="The card pay-per-use calls are billed to."
        >
          {billing.card ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-md bg-secondary">
                  <CreditCard className="size-4 text-foreground" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {billing.card.brand} ending {billing.card.last4}
                  </p>
                  <p className="text-xs text-muted-foreground">Linked {fmtDate(billing.card.linkedISO)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <LinkCardButton variant="outline" size="sm" label="Replace" />
                <Button variant="ghost" size="sm" onClick={unlinkCard}>
                  Unlink
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border bg-background p-4">
              <p className="text-sm text-muted-foreground">
                No card linked. Link a card to authorize pay-per-use spending up to your limits.
              </p>
              <LinkCardButton />
            </div>
          )}
        </SectionCard>

        {/* Billing history. */}
        <SectionCard title="Billing history" description="Past invoices for this account.">
          {billing.invoices.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {billing.invoices.map((inv) => (
                <InfoRow
                  key={inv.id}
                  label={fmtDate(inv.dateISO)}
                  value={
                    <span className="flex items-center gap-2.5">
                      <span className="tabular-nums">{fmtUsd(inv.amountUsd)}</span>
                      <Badge variant="secondary" className="capitalize">
                        {inv.status}
                      </Badge>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
