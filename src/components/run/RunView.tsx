"use client";

// Masterkey — the run / chat view (W5 + W8). Subscribes ONLY via the §6 seam's useRunSubscription
// (never useRealtimeRun directly — W-S M9) and renders the WHOLE chat session as one continuous thread:
// every run in the parentRunId chain (root → follow-ups), each as a user "ask" bubble + its typed
// StepCards. A follow-up continues the same thread (no page switch) and the agent replays the prior
// conversation as context (brain.ts). Anonymous users are gated; a non-owned/unknown run shows not-found.

import Link from "next/link";
import { useEffect } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useRunSubscription } from "@/lib/runtime/use-run-subscription";
import { Shimmer } from "@/components/studio/ai-elements/shimmer";
import type { RunStatus } from "@/lib/chat/types";
import type { SessionSegment } from "@/lib/runtime/types";
import { useSignInGate } from "@/components/auth/sign-in-gate";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { StepCard } from "@/components/run/StepCard";
import { Composer } from "@/components/run/Composer";
import { Button } from "@/components/ui/button";

const TERMINAL: RunStatus[] = ["complete", "failed", "capped", "canceled"];

const STATUS_META: Record<RunStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-muted text-muted-foreground" },
  running: { label: "Running", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  awaiting_approval: { label: "Awaiting approval", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  complete: { label: "Complete", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
  capped: { label: "Capped", cls: "bg-destructive/15 text-destructive" },
  canceled: { label: "Canceled", cls: "bg-muted text-muted-foreground" },
};

function fmtCost(n?: number): string {
  if (n == null || n <= 0) return "$0.00";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

/** One run within the session: the user's ask, then its transcript. Only the LATEST segment can have a
 *  live approval (older approvals are historical). */
function SegmentView({ segment, isLatest, sessionStatus }: { segment: SessionSegment; isLatest: boolean; sessionStatus: RunStatus }) {
  const { run, steps } = segment;

  // Hide a `pending` ("generating…") step once its async result (same toolUseId) has arrived.
  const resolvedToolUseIds = new Set(
    steps.filter((s) => s.kind === "result").map((s) => (s.data as { toolUseId?: string })?.toolUseId).filter(Boolean),
  );
  const visibleSteps = steps.filter(
    (s) => !(s.kind === "pending" && resolvedToolUseIds.has((s.data as { toolUseId?: string })?.toolUseId)),
  );
  // "used N services" = run_service results that produced outputs.
  const serviceCount = steps.filter(
    (s) => s.kind === "result" && Array.isArray((s.data as { structured?: { outputs?: unknown } })?.structured?.outputs),
  ).length;
  // Only the latest segment's most-recent approval drives the live waitpoint.
  let lastApprovalIdx = -1;
  if (isLatest && sessionStatus === "awaiting_approval") {
    for (let i = visibleSteps.length - 1; i >= 0; i--) {
      if (visibleSteps[i].kind === "approval") {
        lastApprovalIdx = i;
        break;
      }
    }
  }

  return (
    <div className="space-y-3">
      {/* The user's ask for this turn of the session. */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm text-foreground">
          {run.goal}
        </div>
      </div>
      {visibleSteps.map((s, i) => (
        <StepCard
          key={s._id}
          step={s}
          approvalActive={i === lastApprovalIdx}
          doneCostUsd={run.providerCostUsd}
          doneServiceCount={serviceCount}
        />
      ))}
    </div>
  );
}

export function RunView({
  runId,
  embedded = false,
  onStatus,
}: {
  runId: string;
  /** Drawer/inline use (spec §10.1): drop the full-page chrome (min-h-svh, "Back to catalog"). */
  embedded?: boolean;
  /** Notifies the host (the test drawer) of live status + running cost so it can mark-ready / show cost. */
  onStatus?: (s: { status: RunStatus; costUsd?: number }) => void;
}) {
  const gate = useSignInGate();
  const { run, segments, status, loaded, refetch } = useRunSubscription(runId);

  // Surface status + cost to the host (e.g. the in-builder test drawer). Parent should memoize onStatus.
  useEffect(() => {
    onStatus?.({ status, costUsd: run?.sessionCostUsd ?? run?.providerCostUsd });
  }, [status, run?.sessionCostUsd, run?.providerCostUsd, onStatus]);

  // Anonymous → gate to sign-in (W1: /run redirects anonymous users to sign-in).
  if (!gate.loading && !gate.signedIn) {
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">Sign in to view this run.</p>
        <Button onClick={gate.openSignIn}>Sign in</Button>
        <SignInDialog {...gate.dialogProps} />
      </main>
    );
  }

  const isTerminal = TERMINAL.includes(status);
  const meta = STATUS_META[status];
  const title = segments[0]?.run.title ?? run?.title ?? run?.goal ?? "Run";
  const latestId = run?._id ?? runId;

  return (
    <main className={embedded ? "flex h-full flex-col p-4" : "mx-auto flex min-h-svh max-w-2xl flex-col p-4"}>
      <header className="mb-4 flex items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          {!embedded && (
            <Link href="/" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3" /> Back to catalog
            </Link>
          )}
          <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Cumulative total across the whole chat session (this run + its follow-ups). SETTLED only. */}
          <span className="text-xs text-muted-foreground" title="Total spent this chat session (confirmed on-chain)">
            {fmtCost(run?.sessionCostUsd ?? run?.providerCostUsd)}
          </span>
          {/* Charges we can't yet tie to an on-chain settlement. Shown SEPARATELY, never folded into the
              total — the reconciler may still void them, and only settled spend counts against the limit.
              Without this the header just reads low for a few minutes and looks like lost money. */}
          {(run?.pendingCostUsd ?? 0) > 0 && (
            <span
              className="text-[11px] text-muted-foreground/70"
              title="Paid, but not yet confirmed on-chain. These settle or void within a few minutes; only settled amounts count toward your limit."
            >
              +{fmtCost(run?.pendingCostUsd)} settling…
            </span>
          )}
          {meta && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>}
        </div>
      </header>

      <section className="flex-1 space-y-5">
        {!loaded && !run ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading run…
          </div>
        ) : loaded && !run ? (
          <div className="p-6 text-sm text-muted-foreground">Run not found.</div>
        ) : segments.every((seg) => seg.steps.length === 0) ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            {isTerminal ? "No output." : <><Loader2 className="size-4 animate-spin" /> Starting your run…</>}
          </div>
        ) : (
          segments.map((seg, i) => (
            <SegmentView
              key={seg.run._id}
              segment={seg}
              isLatest={i === segments.length - 1}
              sessionStatus={status}
            />
          ))
        )}
      </section>

      {run && (
        <footer className="mt-4 border-t pt-3">
          {isTerminal ? (
            <Composer parentRunId={latestId} placeholder="Ask a follow-up…" onSubmitted={refetch} />
          ) : status === "awaiting_approval" ? (
            <p className="text-xs text-muted-foreground">This run is waiting for your approval above.</p>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              <Shimmer className="text-xs" duration={1.6}>
                Working on your run — steps can take a minute each. You can leave; it keeps going.
              </Shimmer>
            </div>
          )}
        </footer>
      )}
    </main>
  );
}
