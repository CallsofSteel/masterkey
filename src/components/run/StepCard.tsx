"use client";

// Masterkey — polymorphic transcript step card (W8). Renders a RunStepDoc by kind:
// text→markdown · tool_call→activity · result→typed renderer (W7) · pending→PendingResult ·
// approval→ApprovalCard · warning→notice · needs_reconcile→refund/retry · error→block · done→summary.

import Markdown from "react-markdown";
import Link from "next/link";
import { Wrench, TriangleAlert, CircleAlert, CircleCheck, ReceiptText } from "lucide-react";
import type { RunStepDoc, ApprovalAction } from "@/lib/chat/types";
import type { RunResult, RunOutput } from "@/lib/mcp/types";
import { ResultStep } from "@/components/run/results/ResultStep";
import { PendingResult } from "@/components/run/results/PendingResult";
import { ApprovalCard } from "@/components/run/ApprovalCard";

function fmtCost(n?: number): string {
  if (n == null || n <= 0) return "$0.00";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function StepCard({
  step,
  onSave,
  approvalActive,
  doneCostUsd,
  doneServiceCount,
}: {
  step: RunStepDoc;
  onSave?: (o: RunOutput) => void;
  approvalActive?: boolean;
  doneCostUsd?: number;
  doneServiceCount?: number;
}) {
  switch (step.kind) {
    case "text": {
      const d = step.data as { text?: string };
      if (!d.text) return null;
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
          <Markdown>{d.text}</Markdown>
        </div>
      );
    }
    case "tool_call": {
      const d = step.data as { tool?: string; input?: unknown };
      return (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2.5 text-xs text-muted-foreground">
          <Wrench className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium text-foreground">{d.tool ?? "tool"}</span>
            {d.input != null && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[11px] opacity-80">
                {typeof d.input === "string" ? d.input : JSON.stringify(d.input)}
              </pre>
            )}
          </div>
        </div>
      );
    }
    case "result": {
      // The step wraps a tool result: { turn, toolUseId, toolName, structured, isError }. A run_service
      // call's `structured` IS a RunResult (has outputs[]) → render it richly. Discovery tool results
      // (get_service / search_services / get_email_inbox) have no outputs and are intermediate → show
      // errors, otherwise render nothing (the tool_call card already shows the call). Reading `step.data`
      // directly here is the bug that crashed the run page (`outputs` was undefined → ImageResult threw).
      const d = step.data as { structured?: unknown; toolName?: string; isError?: boolean };
      const s = d.structured as (RunResult & { structured?: RunResult }) | null | undefined;
      const rr: RunResult | null =
        s && Array.isArray(s.outputs)
          ? s
          : s && Array.isArray(s.structured?.outputs)
            ? (s.structured as RunResult)
            : null;
      if (rr) return <ResultStep result={rr} onSave={onSave} />;
      if (d.isError) {
        const msg =
          (s as { error?: string; message?: string } | null)?.error ??
          (s as { message?: string } | null)?.message ??
          `${d.toolName ?? "Tool"} failed.`;
        return (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{msg}</span>
          </div>
        );
      }
      return null;
    }
    case "pending": {
      const d = step.data as { serviceName?: string; jobId?: string };
      return <PendingResult serviceName={d.serviceName} />;
    }
    case "approval": {
      const d = step.data as {
        action?: ApprovalAction;
        draftPreview?: string;
        budget?: { spentUsd: number; budgetUsd: number; estimateUsd: number };
      };
      return (
        <ApprovalCard
          runId={step.runId}
          action={d.action ?? "email"}
          draftPreview={d.draftPreview}
          active={approvalActive}
          budget={d.budget}
        />
      );
    }
    case "warning": {
      const d = step.data as { text?: string; message?: string; limit?: boolean };
      return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {d.text ?? d.message ?? "Heads up."}
            {d.limit && (
              <>
                {" "}
                <Link href="/dashboard/limits" className="font-medium underline">
                  Adjust your limits
                </Link>
                .
              </>
            )}
          </span>
        </div>
      );
    }
    case "needs_reconcile": {
      return (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <CircleAlert className="size-3.5" />
            Payment unconfirmed
          </div>
          <p className="text-muted-foreground">
            A paid step couldn’t be confirmed (no double-charge occurred). This run can be refunded or retried.
          </p>
        </div>
      );
    }
    case "error": {
      const d = step.data as { message?: string };
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{d.message ?? "Something went wrong."}</span>
        </div>
      );
    }
    case "done": {
      // The done step itself only stores {turn}; the authoritative total is the RunDoc's providerCostUsd
      // (passed in as doneCostUsd) and the service count is derived from the transcript (doneServiceCount).
      const d = step.data as { providerCostUsd?: number; serviceCount?: number };
      const cost = doneCostUsd ?? d.providerCostUsd;
      const count = doneServiceCount ?? d.serviceCount;
      return (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2.5 text-xs text-muted-foreground">
          <CircleCheck className="size-3.5 text-emerald-600" />
          <span>
            Done{count != null && count > 0 ? ` · used ${count} service${count === 1 ? "" : "s"}` : ""} ·{" "}
            <ReceiptText className="inline size-3" /> {fmtCost(cost)}
          </span>
        </div>
      );
    }
    default:
      return null;
  }
}
