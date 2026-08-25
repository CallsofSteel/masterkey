"use client";

// Masterkey — Bundle Studio AI build-assist chat bar (spec §8.3). Ported from Flow's chat-bar, re-pointed
// from the old Claude-Agent-SDK /api/chat job queue to our SYNCHRONOUS Messages-API brain at
// /api/studio/assist (§8.1/§8.2). On send it posts the LIVE canvas graph + the message; the brain edits the
// graph (add/update/connect/remove nodes, draft a whole graph, set metadata) and replies. We apply the
// returned graph to the Jotai atoms (optimistic), persist via autosave, and show a one-line "what changed".

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Loader2, Send, Sparkles, AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Shimmer } from "@/components/studio/ai-elements/shimmer";
import {
  assistReviewRunIdAtom,
  autosaveAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  selectedNodeAtom,
  type WorkflowEdge,
  type WorkflowNode,
} from "@/lib/studio/workflow-store";
import { api } from "@/lib/studio/api-client";
import { cn } from "@/lib/utils";

type AssistOp =
  | { op: "add_node"; kind: string; id: string; label: string }
  | { op: "update_node"; id: string; label: string }
  | { op: "remove_node"; id: string }
  | { op: "connect_nodes"; source: string; target: string }
  | { op: "set_metadata"; fields: string[] }
  | { op: "draft_graph"; nodes: number; edges: number };

type ChatTurn = { role: "user" | "assistant"; text: string; changed?: string | null; error?: boolean };

// Rotated while the brain works, so the user sees forward motion (not a frozen spinner). The phrases are
// generic-but-plausible for the build-assist loop (search → choose → wire → draft).
const WORKING_PHRASES = [
  "Thinking through your request…",
  "Searching the registry for the right services…",
  "Choosing services and wiring the steps…",
  "Drafting the bundle…",
  "Putting it together…",
];

// Render the brain's patch ops as a compact "what changed" line.
function summarizeOps(ops: AssistOp[]): string | null {
  const draft = ops.find((o): o is Extract<AssistOp, { op: "draft_graph" }> => o.op === "draft_graph");
  const parts: string[] = [];
  if (draft) parts.push(`drafted ${draft.nodes} node${draft.nodes === 1 ? "" : "s"}, ${draft.edges} connection${draft.edges === 1 ? "" : "s"}`);
  const added = ops.filter((o) => o.op === "add_node").length;
  const updated = ops.filter((o) => o.op === "update_node").length;
  const removed = ops.filter((o) => o.op === "remove_node").length;
  const connected = ops.filter((o) => o.op === "connect_nodes").length;
  const meta = ops.some((o) => o.op === "set_metadata");
  if (added) parts.push(`+${added} node${added === 1 ? "" : "s"}`);
  if (updated) parts.push(`${updated} updated`);
  if (removed) parts.push(`−${removed} removed`);
  if (connected) parts.push(`${connected} connection${connected === 1 ? "" : "s"}`);
  if (meta) parts.push("metadata");
  return parts.length ? parts.join(" · ") : null;
}

export function ChatBar() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const [workflowName, setWorkflowName] = useAtom(currentWorkflowNameAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const [nodes, setNodes] = useAtom(nodesAtom);
  const [edges, setEdges] = useAtom(edgesAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const triggerAutosave = useSetAtom(autosaveAtom);

  const [reviewRunId, setReviewRunId] = useAtom(assistReviewRunIdAtom);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reviewedRef = useRef<string | null>(null);

  // Advance the "working" phrase while the brain runs (resets when idle).
  useEffect(() => {
    if (!sending) {
      setPhraseIdx(0);
      return;
    }
    const t = setInterval(() => setPhraseIdx((p) => Math.min(p + 1, WORKING_PHRASES.length - 1)), 2800);
    return () => clearInterval(t);
  }, [sending]);

  // Core send. `reviewId` (the debug loop) tells the brain to read that test run's transcript first.
  const send = async (message: string, reviewId?: string) => {
    if (!message || sending) return;

    setSending(true);
    setTurns((prev) => [...prev, { role: "user", text: reviewId ? `Review the last test run and fix any issues.` : message }]);

    try {
      const res = await fetch("/api/studio/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          nodes,
          edges,
          focusNodeId: selectedNode?.id ?? null,
          name: workflowName || undefined,
          ...(reviewId ? { reviewRunId: reviewId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTurns((prev) => [...prev, { role: "assistant", text: data.error || "Something went wrong.", error: true }]);
        return;
      }

      // Apply the returned graph (optimistic). Re-tag edges so they render with the animated edge type.
      const nextNodes = (data.nodes ?? []) as WorkflowNode[];
      const nextEdges = ((data.edges ?? []) as WorkflowEdge[]).map((e) => ({ ...e, type: e.type ?? "animated" }));
      setNodes(nextNodes);
      setEdges(nextEdges);
      setHasUnsavedChanges(true);

      // Persist metadata the brain set (name → atom + save; description → save), then flush the graph save.
      const meta = data.metadata as { name?: string; description?: string; trigger?: string } | null;
      if (meta?.name) setWorkflowName(meta.name);
      if (workflowId && meta && (meta.name || meta.description || meta.trigger)) {
        api.workflow.update(workflowId, { name: meta.name, description: meta.description }).catch(() => {});
      }
      triggerAutosave({ immediate: true });

      setTurns((prev) => [...prev, { role: "assistant", text: data.reply || "Done.", changed: summarizeOps((data.ops ?? []) as AssistOp[]) }]);
    } catch {
      setTurns((prev) => [...prev, { role: "assistant", text: "Couldn't reach build-assist. Try again.", error: true }]);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "20px";
    void send(message);
  };

  // Debug loop (§ user ask): the test drawer sets assistReviewRunIdAtom when a test finishes → auto-send a
  // "review this run" turn so the same brain reads the transcript (get_run_result) and fixes the graph.
  // `sending` is in the deps so a request made mid-send still fires once the in-flight turn finishes; the
  // ref guard prevents a double-send (and re-clicking the same run is a no-op until reset).
  useEffect(() => {
    if (!reviewRunId || sending) return;
    if (reviewedRef.current === reviewRunId) return;
    reviewedRef.current = reviewRunId;
    setReviewRunId(null);
    void send("Review the end-to-end test run of this bundle and fix or improve anything that failed.", reviewRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRunId, sending]);

  const visible = turns.slice(-4);

  return (
    <div className="pointer-events-auto fixed bottom-4 left-1/2 z-30 w-full max-w-xl -translate-x-1/2 px-4">
      {/* Transcript (recent turns) */}
      {(visible.length > 0 || sending) && (
        <div className="mb-2 max-h-64 space-y-1.5 overflow-y-auto">
          {visible.map((t, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm",
                t.role === "user" && "border-primary/30",
                t.error && "border-red-500/40",
              )}
            >
              <div className="flex items-start gap-2">
                {t.role === "assistant" ? (
                  t.error ? <AlertCircle className="mt-0.5 size-3 shrink-0 text-red-500" /> : <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
                ) : (
                  <span className="mt-0.5 shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">You</span>
                )}
                <span className={cn("flex-1 whitespace-pre-wrap", t.role === "user" ? "text-foreground" : t.error ? "text-red-500" : "text-muted-foreground")}>
                  {t.text}
                </span>
              </div>
              {t.changed && (
                <p className="mt-1 pl-5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">✓ {t.changed}</p>
              )}
            </div>
          ))}

          {/* Shimmering "working" row — clear, animated progress so the run never looks frozen. */}
          {sending && (
            <div className="rounded-lg border border-primary/20 bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <Sparkles className="size-3 shrink-0 animate-pulse text-primary" />
                <Shimmer className="text-xs" duration={1.6}>
                  {WORKING_PHRASES[phraseIdx]}
                </Shimmer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input bar */}
      <div className="flex items-center gap-2 rounded-xl border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {selectedNode && (
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-muted-foreground">Focused:</span>
              <span className="max-w-[180px] truncate rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
                {selectedNode.data.label || selectedNode.data.name || selectedNode.data.type}
              </span>
            </div>
          )}
          <textarea
            ref={inputRef}
            autoComplete="off"
            className="max-h-40 w-full resize-none overflow-y-auto bg-transparent text-sm leading-5 placeholder:text-muted-foreground focus:outline-none"
            disabled={sending}
            name="studio-assist-input"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={selectedNode ? `Ask about "${selectedNode.data.label || selectedNode.data.type}"…` : "Ask Claude to build or edit this bundle…"}
            rows={1}
            style={{ height: "20px" }}
            value={input}
          />
        </div>
        <button
          className="rounded-lg bg-primary p-1.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={!input.trim() || sending}
          onClick={handleSend}
          type="button"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
    </div>
  );
}
