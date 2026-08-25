"use client";

// Masterkey — Bundle Studio in-builder test drawer (spec §9.2 / §10.1). The "Test" button opens THIS over
// the canvas instead of navigating to /run/[id], so the graph stays visible/editable and the build-assist
// chat sits right beside it (never feels "done"). It (1) collects the bundle's inputs[] up-front and threads
// them into the run seed (§9.2), (2) starts a normal durable run of the compiled bundle, (3) shows the live
// transcript by reusing <RunView embedded>, and (4) on terminal offers the DEBUG LOOP — hand the run to the
// same brain that built it (via assistReviewRunIdAtom) to diagnose/fix — plus "Mark as ready" on success.

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X, Sparkles, CheckCircle2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RunView } from "@/components/run/RunView";
import { api } from "@/lib/studio/api-client";
import {
  activeTestRunIdAtom,
  assistReviewRunIdAtom,
  currentWorkflowIdAtom,
  edgesAtom,
  nodesAtom,
  testDrawerOpenAtom,
} from "@/lib/studio/workflow-store";
import type { RunStatus } from "@/lib/chat/types";

const TERMINAL: RunStatus[] = ["complete", "failed", "capped", "canceled"];

function kebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type DerivedInput = { name: string; prompt: string; required: boolean };

export function TestRunDrawer() {
  const [open, setOpen] = useAtom(testDrawerOpenAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [activeRunId, setActiveRunId] = useAtom(activeTestRunIdAtom);
  const setReviewRunId = useSetAtom(assistReviewRunIdAtom);

  const [phase, setPhase] = useState<"prep" | "inputs" | "run">("prep");
  const [slug, setSlug] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [markedReady, setMarkedReady] = useState(false);
  const [reviewSent, setReviewSent] = useState(false);
  const preppedFor = useRef<string | null>(null);

  // Derive the inputs the bundle expects from its input nodes (matches compile.ts) — authoritative even
  // when doc.inputs is stale/empty for a freshly-built studio bundle.
  const derivedInputs: DerivedInput[] = nodes
    .filter((n) => (n.data?.type ?? n.type) === "input")
    .map((n, i) => {
      const label = n.data?.label || `Input ${i + 1}`;
      return {
        name: n.data?.saveAs || kebab(label) || `input_${i + 1}`,
        prompt: n.data?.prompt || label,
        required: n.data?.required !== false,
      };
    });

  const startRun = useCallback(
    async (bundleSlug: string | null | undefined, inputVals: Record<string, string>) => {
      if (!bundleSlug) {
        setError("This bundle has no slug yet — save it first.");
        return;
      }
      setStarting(true);
      setError(null);
      try {
        // Thread inputs into the seed: the recipe says "treat the rest of the message as the bundle's input".
        const filled = derivedInputs
          .map((inp) => ({ inp, v: (inputVals[inp.name] ?? "").trim() }))
          .filter(({ v }) => v.length > 0);
        const goal =
          `/${bundleSlug}` +
          (filled.length ? `\n\nInputs for this run:\n${filled.map(({ inp, v }) => `- ${inp.name}: ${v}`).join("\n")}` : "");

        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal }),
        });
        const data = await res.json();
        if (data.runId) {
          setActiveRunId(data.runId);
          setStatus(null);
          setMarkedReady(false);
          setPhase("run");
        } else {
          setError(data.error || "Failed to start the test run.");
        }
      } catch {
        setError("Failed to start the test run.");
      } finally {
        setStarting(false);
      }
    },
    [derivedInputs, setActiveRunId],
  );

  // On open: save the latest graph, resolve the slug, then decide inputs-form vs. straight-to-run.
  useEffect(() => {
    if (!open || !workflowId) return;
    if (preppedFor.current === workflowId && (phase !== "prep" || activeRunId)) return;
    preppedFor.current = workflowId;
    setError(null);
    setPhase("prep");
    (async () => {
      try {
        await api.workflow.update(workflowId, { nodes, edges });
        const bundle = await api.workflow.getById(workflowId);
        setSlug(bundle.slug ?? null);
        setPhase(derivedInputs.length ? "inputs" : "prep");
        if (!derivedInputs.length) void startRun(bundle.slug, {});
      } catch {
        setError("Couldn't prepare the bundle for testing.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId]);

  const onStatus = useCallback((s: { status: RunStatus; costUsd?: number }) => {
    setStatus(s.status);
    setCost(s.costUsd);
  }, []);

  // §10.2: a successful test marks the bundle ready (+ lastTestedISO server-side).
  const markReady = useCallback(async () => {
    if (!workflowId) return;
    try {
      await api.workflow.update(workflowId, { status: "ready" });
      setMarkedReady(true);
    } catch {
      /* non-fatal */
    }
  }, [workflowId]);

  // Debug loop (§ user ask): hand the run to the same brain (the chat bar) to review/fix. The conversation
  // happens in the chat bar at the bottom of the canvas, so we show an in-drawer banner pointing there.
  const reviewWithAssistant = useCallback(() => {
    if (!activeRunId) return;
    setReviewRunId(activeRunId);
    setReviewSent(true);
  }, [activeRunId, setReviewRunId]);

  const close = useCallback(() => {
    setOpen(false);
    setPhase("prep");
    setActiveRunId(null);
    setStatus(null);
    setValues({});
    setReviewSent(false);
    preppedFor.current = null;
  }, [setOpen, setActiveRunId]);

  const reset = useCallback(() => {
    setActiveRunId(null);
    setStatus(null);
    setReviewSent(false);
    setPhase(derivedInputs.length ? "inputs" : "prep");
    if (!derivedInputs.length) void startRun(slug, {});
  }, [derivedInputs.length, slug, startRun, setActiveRunId]);

  if (!open) return null;
  const isTerminal = status != null && TERMINAL.includes(status);

  return (
    <div className="absolute right-0 top-0 z-40 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Play className="size-4 text-green-600" />
          <span className="text-sm font-semibold">Test run</span>
          {status && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{status}</span>
          )}
        </div>
        <button onClick={close} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
        )}

        {phase === "prep" && !error && (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Preparing test…
          </div>
        )}

        {phase === "inputs" && (
          <div className="space-y-4 p-4">
            <p className="text-xs text-muted-foreground">
              This bundle asks for {derivedInputs.length} input{derivedInputs.length === 1 ? "" : "s"}. Fill them in, then run the end-to-end test.
            </p>
            {derivedInputs.map((inp) => (
              <label key={inp.name} className="block space-y-1">
                <span className="text-xs font-medium text-foreground">
                  {inp.prompt}
                  {inp.required && <span className="text-destructive"> *</span>}
                </span>
                <textarea
                  rows={2}
                  value={values[inp.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [inp.name]: e.target.value }))}
                  placeholder={`e.g. value for ${inp.name}`}
                  className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </label>
            ))}
            <Button
              className="w-full gap-1.5 bg-green-600 text-white hover:bg-green-700"
              disabled={starting || derivedInputs.some((i) => i.required && !(values[i.name] ?? "").trim())}
              onClick={() => startRun(slug, values)}
            >
              {starting ? <><Loader2 className="size-4 animate-spin" /> Starting…</> : <><Play className="size-4" /> Run end-to-end test</>}
            </Button>
          </div>
        )}

        {phase === "run" && activeRunId && (
          <RunView runId={activeRunId} embedded onStatus={onStatus} />
        )}
      </div>

      {/* Footer actions (terminal) — the debug loop + mark ready (§10.2). */}
      {phase === "run" && isTerminal && (
        <div className="shrink-0 space-y-2 border-t border-border p-3">
          {cost != null && cost > 0 && (
            <p className="text-center text-[11px] text-muted-foreground">Test cost: ${cost.toFixed(cost < 0.01 ? 4 : 2)}</p>
          )}
          {reviewSent && (
            <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px] text-foreground">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>
                Sent to the assistant — it&apos;s reviewing this run in the <span className="font-medium">chat at the bottom of the canvas</span> and will update the bundle there.
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={reviewWithAssistant} disabled={reviewSent}>
              <Sparkles className="size-3.5 text-primary" /> {reviewSent ? "Reviewing in chat…" : "Ask assistant to review"}
            </Button>
            {status === "complete" &&
              (markedReady ? (
                <Button variant="ghost" size="sm" className="flex-1 gap-1.5 text-emerald-600" disabled>
                  <CheckCircle2 className="size-3.5" /> Marked ready
                </Button>
              ) : (
                <Button size="sm" className="flex-1 gap-1.5" onClick={markReady}>
                  <CheckCircle2 className="size-3.5" /> Mark as ready
                </Button>
              ))}
          </div>
          <button onClick={reset} className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground">
            Run another test
          </button>
        </div>
      )}
    </div>
  );
}
