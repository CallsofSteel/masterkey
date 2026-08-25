"use client";

// PendingResult (W7): the "generating…" state for an in-flight provider job within a step. Driven by
// a `pending` RunStepDoc ({jobId,serviceName}), not the RunResult registry.

import { Loader2 } from "lucide-react";

export function PendingResult({ serviceName, note }: { serviceName?: string; note?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card p-3 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin text-foreground" />
      <span>
        {serviceName ? <span className="font-medium text-foreground">{serviceName}</span> : "Working"}
        {" — "}
        {note ?? "generating…"}
      </span>
    </div>
  );
}
