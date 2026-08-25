// Masterkey — Bundle Studio run-review helper (server-only). Powers the build-assist DEBUG LOOP: it reads a
// finished/in-flight TEST run (ownership-checked) and renders a COMPACT, brain-friendly summary — status,
// cost, the ordered transcript steps, and any errors/warnings/blockers — so the same brain that built the
// bundle can diagnose what happened and fix/improve the graph. Never import from client code.

import { getSessionForUser } from "@/lib/chat/db";
import type { RunStepDoc, RunStatus } from "@/lib/chat/types";

export interface RunReview {
  found: boolean;
  status?: RunStatus;
  costUsd?: number;
  goal?: string;
  steps?: { kind: string; text: string }[];
  errors?: string[];
  warnings?: string[];
  note?: string;
}

function clip(s: unknown, n = 400): string {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** Render one transcript step into a short line the brain can reason over. */
function stepLine(step: RunStepDoc): { kind: string; text: string } {
  const d = step.data as Record<string, unknown> | undefined;
  switch (step.kind) {
    case "text":
      return { kind: "text", text: clip(d?.text) };
    case "tool_call":
      return { kind: "tool_call", text: `${clip(d?.tool, 60)} ${clip(d?.input, 240)}` };
    case "result": {
      const structured = d?.structured as { ok?: boolean; outputs?: unknown; error?: unknown } | undefined;
      const ok = structured?.ok !== false && !structured?.error;
      const detail = structured?.error ? `error: ${clip(structured.error, 240)}` : clip(structured?.outputs ?? d?.summary, 240);
      return { kind: "result", text: `${ok ? "ok" : "FAILED"} — ${detail}` };
    }
    case "pending":
      return { kind: "pending", text: `generating: ${clip(d?.serviceName, 80)}` };
    case "approval":
      return { kind: "approval", text: `approval(${clip(d?.action, 40)}) ${d?.decision ? `→ ${clip(d?.decision, 40)}` : "(unresolved)"}` };
    case "error":
      return { kind: "error", text: clip(d?.text ?? d?.message ?? d) };
    case "warning":
      return { kind: "warning", text: clip(d?.text ?? d?.message ?? d) };
    case "done":
      return { kind: "done", text: `finished (cost $${Number(d?.providerCostUsd ?? 0).toFixed(4)})` };
    default:
      return { kind: step.kind, text: clip(d, 160) };
  }
}

/** Ownership-checked, compact review of a run (latest segment of its session) for the build-assist brain. */
export async function summarizeRunForReview(runId: string, userId: string): Promise<RunReview> {
  const session = await getSessionForUser(runId, userId);
  if (!session) return { found: false, note: `run "${runId}" not found or not yours` };

  // Review the LATEST segment (the test run itself; ignore unrelated earlier follow-ups for token budget).
  const latest = session.segments[session.segments.length - 1];
  const lines = latest.steps.map(stepLine);
  const errors = lines.filter((l) => l.kind === "error" || (l.kind === "result" && l.text.startsWith("FAILED"))).map((l) => l.text);
  const warnings = lines.filter((l) => l.kind === "warning").map((l) => l.text);

  return {
    found: true,
    status: session.latest.status,
    costUsd: session.latest.providerCostUsd,
    goal: latest.run.goal,
    steps: lines,
    errors: errors.length ? errors : undefined,
    warnings: warnings.length ? warnings : undefined,
  };
}
