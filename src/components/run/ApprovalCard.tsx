"use client";

// Masterkey — approval card (W6 + W-S M7). When `active` (the run is paused on THIS waitpoint), the
// buttons complete it via POST /api/runs/[id]/approve → wait.completeToken. Two kinds:
//  • SEND approval (email/sms/mail/call/purchase/publish): approve / edit / regenerate / reject.
//  • BUDGET pause (action="budget", W-S M7): the next paid step would exceed the run's per-run budget →
//    raise & continue, or stop. The waitpoint tokenId stays server-only (the route reads it — W-S C5).

import { useState } from "react";
import { Mail, Phone, Send, ShoppingCart, Megaphone, MailOpen, Wallet, Loader2, Check, X } from "lucide-react";
import type { ApprovalAction } from "@/lib/chat/types";
import { Button } from "@/components/ui/button";

const ICON: Record<ApprovalAction, typeof Mail> = {
  email: Mail,
  sms: Send,
  mail: MailOpen,
  call: Phone,
  purchase: ShoppingCart,
  publish: Megaphone,
  budget: Wallet,
};
const LABEL: Record<ApprovalAction, string> = {
  email: "Send email",
  sms: "Send SMS",
  mail: "Send physical mail",
  call: "Place a call",
  purchase: "Make a purchase",
  publish: "Publish publicly",
  budget: "Budget limit reached",
};

type Decision = "approve" | "edit" | "regenerate" | "reject";
const fmt = (n: number) => `$${(n ?? 0).toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

export function ApprovalCard({
  runId,
  action,
  draftPreview,
  active = false,
  budget,
}: {
  runId: string;
  action: ApprovalAction;
  draftPreview?: string;
  active?: boolean;
  budget?: { spentUsd: number; budgetUsd: number; estimateUsd: number };
}) {
  const Icon = ICON[action] ?? Send;
  const isBudget = action === "budget";
  const [pending, setPending] = useState<Decision | null>(null);
  const [submitted, setSubmitted] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draftPreview ?? "");

  async function decide(a: Decision, input?: unknown) {
    setPending(a);
    setError(null);
    try {
      const decision = input !== undefined ? { action: a, payload: { input } } : { action: a };
      const res = await fetch(`/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setError(e.error ?? "Couldn't submit your decision — try again.");
        setPending(null);
        return;
      }
      setSubmitted(a);
      setEditing(false);
    } catch {
      setError("Network error — try again.");
      setPending(null);
    }
  }

  function saveEdit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editText);
    } catch {
      setError("The draft isn't valid JSON — fix it and retry.");
      return;
    }
    void decide("edit", parsed);
  }

  const busy = pending !== null;

  // ---- Budget pause variant (W-S M7) ----
  if (isBudget) {
    return (
      <div className="space-y-3 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Wallet className="size-4 text-sky-600" />
          {LABEL.budget}
        </div>
        <p className="text-xs text-muted-foreground">
          This run has spent <span className="font-medium text-foreground">{fmt(budget?.spentUsd ?? 0)}</span> of its{" "}
          <span className="font-medium text-foreground">{fmt(budget?.budgetUsd ?? 0)}</span> budget; the next step would
          likely exceed it. Raise the budget to continue, or stop the run.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {submitted ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 text-emerald-600" />
            {submitted === "approve" ? "Budget raised — continuing…" : "Stopped at the budget limit."}
          </p>
        ) : !active ? (
          <p className="text-[11px] text-muted-foreground">This budget prompt has been resolved.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => decide("approve")} disabled={busy}>
              {pending === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
              Raise budget &amp; continue
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => decide("reject")} disabled={busy}>
              {pending === "reject" ? <Loader2 className="size-4 animate-spin" /> : <X className="size-3.5" />}
              Stop run
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ---- Send-approval variant ----
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="size-4 text-amber-600" />
        Approval needed — {LABEL[action] ?? "outward action"}
      </div>

      {!submitted && active && (
        <p className="text-xs text-muted-foreground">
          This run paused before an outward action. Review the draft, then approve, edit, regenerate, or reject.
        </p>
      )}

      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs outline-none"
        />
      ) : (
        draftPreview && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 text-xs">
            {draftPreview}
          </pre>
        )
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {submitted ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-emerald-600" />
          {submitted === "reject"
            ? "Rejected — nothing was sent."
            : submitted === "regenerate"
              ? "Asked for a revision — the run is producing a new draft…"
              : "Approved — resuming the run…"}
        </p>
      ) : !active ? (
        <p className="text-[11px] text-muted-foreground">This approval has been resolved.</p>
      ) : editing ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={saveEdit} disabled={busy}>
            {pending === "edit" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Save &amp; send
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => decide("approve")} disabled={busy}>
            {pending === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Approve &amp; send
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setEditing(true); setEditText(draftPreview ?? ""); setError(null); }}
            disabled={busy}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => decide("regenerate")} disabled={busy}>
            {pending === "regenerate" ? <Loader2 className="size-4 animate-spin" /> : null}
            Regenerate
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => decide("reject")} disabled={busy}>
            {pending === "reject" ? <Loader2 className="size-4 animate-spin" /> : <X className="size-3.5" />}
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
