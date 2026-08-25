"use client";

import { useState } from "react";
import { Plus, Trash2, Mail, ShieldCheck, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LinkCardButton } from "@/components/account/link-card-dialog";
import { useAccount, fmtUsd, fmtDate, pctUsed } from "@/lib/account";
import {
  SPEND_BUCKETS,
  RULE_PERIODS,
  scopeLabel,
  type RuleScope,
  type RulePeriod,
} from "@/lib/spend-buckets";
import { PageHeader, SectionCard } from "../_components/ui";

// $-prefixed numeric input with free-typing local state, committing a number on change.
function MoneyInput({
  value,
  onChange,
  id,
  className,
  placeholder = "0",
  autoFocus,
}: {
  value: number;
  onChange: (n: number) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(value) : "");
  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
      <Input
        id={id}
        inputMode="decimal"
        autoFocus={autoFocus}
        className="pl-6 tabular-nums"
        placeholder={placeholder}
        value={shown}
        onChange={(e) => {
          // Digits + at most one decimal point; minus signs are dropped (no negative spend).
          let v = e.target.value.replace(/[^0-9.]/g, "");
          const dot = v.indexOf(".");
          if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
          setDraft(v);
          const n = parseFloat(v);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

const LIMIT_PRESETS = [20, 50, 100, 200];

function AdjustLimitDialog() {
  const { account, setMonthlyLimit } = useAccount();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(account.spend.monthlyLimitUsd);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(account.spend.monthlyLimitUsd);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Adjust limit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Monthly spend limit</DialogTitle>
          <DialogDescription>
            The most you can spend across all services in a billing period. Calls are declined once you hit it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="limit">Limit</Label>
            <MoneyInput key={String(open)} id="limit" value={value} onChange={setValue} autoFocus />
          </div>
          <div className="flex flex-wrap gap-2">
            {LIMIT_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setValue(p)}
                aria-label={`Set monthly limit to ${fmtUsd(p, { cents: false })}`}
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium tabular-nums text-foreground transition-colors hover:bg-accent"
              >
                {fmtUsd(p, { cents: false })}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setMonthlyLimit(value);
              setOpen(false);
            }}
          >
            Save limit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PerCallDialog() {
  const { account, setPerCallMax } = useAccount();
  const [open, setOpen] = useState(false);
  const current = account.spend.perCallMaxUsd;
  const [value, setValue] = useState(current ?? 1);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(account.spend.perCallMaxUsd ?? 1);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {current == null ? "Set per-call max" : "Edit"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Per-call maximum</DialogTitle>
          <DialogDescription>
            The most a single call may cost. Anything above this is declined automatically — a guardrail against a
            runaway agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="percall">Maximum per call</Label>
          <MoneyInput key={String(open)} id="percall" value={value} onChange={setValue} placeholder="1.00" autoFocus />
        </div>
        <DialogFooter className="sm:justify-between">
          {current != null && (
            <Button
              variant="ghost"
              onClick={() => {
                setPerCallMax(null);
                setOpen(false);
              }}
            >
              Remove cap
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setPerCallMax(value);
                setOpen(false);
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAlertDialog() {
  const { account, addAlert } = useAccount();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("80");
  const [email, setEmail] = useState(account.user.email);

  const valid = Number(pct) >= 1 && Number(pct) <= 100 && /.+@.+\..+/.test(email);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setPct("80");
          setEmail(account.user.email);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          Add notification
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Email notification</DialogTitle>
          <DialogDescription>Get emailed when spend reaches a percentage of your monthly limit.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pct">Threshold (% of monthly limit)</Label>
            <div className="relative">
              <Input
                id="pct"
                inputMode="numeric"
                autoFocus
                className="pr-7 tabular-nums"
                value={pct}
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
                  // Clamp to 1–100 once it's a complete number; allow empty while typing.
                  if (digits === "") return setPct("");
                  setPct(String(Math.min(100, parseInt(digits, 10))));
                }}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alert-email">Email</Label>
            <Input id="alert-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              addAlert(Number(pct), email.trim());
              setOpen(false);
            }}
          >
            Add notification
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LimitsPage() {
  const { account, hydrated, setAdvancedEnabled, addRule, updateRule, removeRule, removeAlert } = useAccount();
  const { spend, billing } = account;
  const pct = pctUsed(account);
  const hasCard = !!billing.card;

  return (
    <>
      <PageHeader
        title="Spend limits"
        description="Cap what your account — and the agents you connect — can spend. Limits apply across the catalog."
      />

      <div className="space-y-5">
        {/* Monthly spend limit (simple top-level). */}
        <SectionCard title="Monthly spend limit" action={<AdjustLimitDialog />}>
          <div className="flex items-end justify-between gap-3">
            <div className="font-heading text-3xl font-normal tabular-nums text-foreground">
              {hydrated ? fmtUsd(billing.spentThisPeriodUsd) : "—"}
              <span className="ml-1 text-base text-muted-foreground">/ {fmtUsd(spend.monthlyLimitUsd)}</span>
            </div>
            <span className="text-sm font-medium tabular-nums text-muted-foreground">{pct}% used</span>
          </div>
          <Progress value={pct} className="mt-3" />
          <p className="mt-2 text-xs text-muted-foreground">Resets {fmtDate(billing.periodResetsISO)}</p>
        </SectionCard>

        {/* Spend permission — ties card + limit; gated on a linked card. */}
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              Spend permission
            </span>
          }
          description="Authorize Masterkey to spend on your behalf so connected agents can make pay-per-use calls without confirming each one."
        >
          {hasCard ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-background p-3 text-sm">
                <p className="text-foreground">
                  Authorized up to{" "}
                  <span className="font-semibold tabular-nums">{fmtUsd(spend.monthlyLimitUsd)}</span> per month on{" "}
                  <span className="font-medium">
                    {billing.card!.brand} ending {billing.card!.last4}
                  </span>
                  .
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Per-call maximum</p>
                  <p className="text-xs text-muted-foreground">
                    {spend.perCallMaxUsd == null
                      ? "No per-call cap — only the monthly limit applies."
                      : `Up to ${fmtUsd(spend.perCallMaxUsd)} per call.`}
                  </p>
                </div>
                <PerCallDialog />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border bg-background p-4">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                Link a card to grant spend permission. Without it, pay-per-use calls can&apos;t run.
              </p>
              <LinkCardButton />
            </div>
          )}
        </SectionCard>

        {/* Advanced — fine-grained rules engine (scope × period × cap). */}
        <SectionCard
          title="Advanced limits"
          description="Fine-grained control: cap spend per category, per day, per session, or per call."
          action={
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{spend.advancedEnabled ? "On" : "Off"}</span>
              <Switch checked={spend.advancedEnabled} onCheckedChange={setAdvancedEnabled} aria-label="Toggle advanced limits" />
            </div>
          }
        >
          {spend.advancedEnabled ? (
            <div className="space-y-3">
              {spend.rules.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-background p-4 text-sm text-muted-foreground">
                  No rules yet. Add one to cap spend on a specific area — e.g. {fmtUsd(20, { cents: false })}/month on
                  Media, or {fmtUsd(2, { cents: false })} per call.
                </p>
              ) : (
                <div className="space-y-2">
                  {spend.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5 sm:flex-row sm:flex-wrap sm:items-center"
                    >
                      <Select
                        value={rule.scope}
                        onValueChange={(v) => updateRule(rule.id, { scope: v as RuleScope })}
                      >
                        <SelectTrigger className="h-8 w-full text-xs sm:w-[150px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Everything</SelectItem>
                          {SPEND_BUCKETS.map((b) => (
                            <SelectItem key={b.key} value={b.key}>
                              {b.short}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={rule.period}
                        onValueChange={(v) => updateRule(rule.id, { period: v as RulePeriod })}
                      >
                        <SelectTrigger className="h-8 w-full text-xs sm:w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_PERIODS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <MoneyInput
                        value={rule.capUsd}
                        onChange={(n) => updateRule(rule.id, { capUsd: n })}
                        className="w-full sm:w-24"
                      />
                      <div className="flex items-center justify-end gap-1.5 sm:ml-auto">
                        <Switch
                          checked={rule.enabled}
                          onCheckedChange={(c) => updateRule(rule.id, { enabled: c })}
                          aria-label="Toggle rule"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeRule(rule.id)}
                          aria-label="Remove rule"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => addRule({ scope: "media", period: "per-month", capUsd: 20 })}
              >
                <Plus className="size-4" />
                Add rule
              </Button>
              {spend.rules.some((r) => r.enabled) && (
                <p className="text-xs text-muted-foreground">
                  Active:{" "}
                  {spend.rules
                    .filter((r) => r.enabled)
                    .map((r) => `${fmtUsd(r.capUsd)} ${RULE_PERIODS.find((p) => p.value === r.period)?.label.toLowerCase()} on ${scopeLabel(r.scope)}`)
                    .join(" · ")}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Turn this on to add rules like {fmtUsd(20, { cents: false })}/month on Media,{" "}
              {fmtUsd(5, { cents: false })}/month on Web search, or {fmtUsd(50, { cents: false })}/day overall.
            </p>
          )}
        </SectionCard>

        {/* Email alerts. */}
        <SectionCard
          title="Email notifications"
          description="Get notified as your monthly spend approaches an amount you set."
          action={<AddAlertDialog />}
        >
          {spend.alerts.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No notifications set.</p>
          ) : (
            <div className="divide-y divide-border">
              {spend.alerts
                .slice()
                .sort((a, b) => a.pct - b.pct)
                .map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Mail className="size-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {alert.pct}% usage alert
                          <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
                            ({fmtUsd((spend.monthlyLimitUsd * alert.pct) / 100)})
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">{alert.email}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeAlert(alert.id)}
                      aria-label="Remove notification"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
