// Masterkey — the brain: Anthropic Messages API tool-use loop (W4). Engine-agnostic — the durable
// Trigger task injects `waitForApproval` (waitpoint) + `sleep` (durable wait); a test harness injects
// auto-approve + setTimeout. Money-safety invariants:
//   • Commit-plan-before-execute: persist the turn's tool plan (with per-call seq/stepKey) BEFORE any
//     tool runs, so a crash-replay re-derives the SAME seq → MCP dedupes (no double-charge).
//   • seq from the DURABLE plan: prior committed run_service calls of the same content + this call's
//     ordinal within the turn — never a racy live count (W-S v2.2).
//   • Resumable: rehydrate messages + completed tool results from persisted RunStepDocs; only an
//     in-flight call re-fires (and dedupes).
//   • Approval is harness-decided (approval-rules), default-deny; the model never self-approves a send.

import Anthropic from "@anthropic-ai/sdk";
import { connectMcp, callMcpTool, MCP_TOOLS, type McpToolName } from "@/lib/agent/tools";
import { RUNNER_SYSTEM_PROMPT, buildSeedMessage } from "@/lib/agent/seed-prompt";
import { classifyApproval } from "@/lib/agent/approval-rules";
import { contentHash, stepKey } from "@/lib/agent/idempotency-key";
import { getSteps, getRun, persistPlanStep, persistStepOnce, patchRun } from "@/lib/chat/db";
import { settledCostForRun } from "@/lib/spend/ledger";
import { mirrorRunOutputs } from "@/lib/chat/mirror";
import type { ApprovalAction } from "@/lib/chat/types";

// claude-sonnet-5: 1M-token context + 128k max output, newer/stronger than sonnet-4-6 at the same price
// tier (cheaper intro pricing through 2026-08-31). Env-overridable if a deployment's Anthropic endpoint
// lacks it. (sonnet-4-6 was already 1M-context; the switch is a quality upgrade, not a context fix.)
const DEFAULT_MODEL = process.env.MASTERKEY_AGENT_MODEL ?? "claude-sonnet-5";
// RUN_RELIABILITY_SPEC 6.4: 12 turns cut the incident off mid-provider-search. A multi-step bundle
// (search→generate→edit→send) legitimately needs more, and spend is bounded INDEPENDENTLY by the per-run
// budget gate + monthly cap — so more turns ≠ more runaway-spend risk. Default 24, env-tunable. (The
// seed-prompt's "don't over-shop / switch on empty results" guidance, 5.3, reduces wasted turns too.)
const MAX_TURNS = Number(process.env.MASTERKEY_MAX_TURNS) || 40;
// Output-token cap per model turn. 4096 was too tight: a turn that emits a large tool_use payload — e.g.
// building an HTML report and passing it to an upload/publish service in one call, or a big result — got
// truncated (stop_reason:"max_tokens") and the run died with the misleading "plan grew too large". Claude
// bills for tokens ACTUALLY generated, not the cap, so a higher cap is ~free for normal (small) turns and
// only lets the occasional big turn complete. Env-tunable.
// Output-token cap per model turn. HARD CEILING from the Anthropic SDK: a NON-STREAMING messages.create
// throws "Streaming is required for operations that may take longer than 10 minutes" when the client has no
// explicit `timeout` AND max_tokens exceeds ~21,333 (the SDK estimates (3600·max_tokens)/128000 s > 600 s).
// 32768 tripped this → EVERY run failed on turn 1 (prod outage 2026-07-16→21). We stay under the threshold
// AND set an explicit client timeout below (which disables the guard entirely), so this can't recur.
const MAX_TOKENS = Number(process.env.MASTERKEY_MAX_TOKENS) || 16384;
const MAX_MAXTOKENS_RETRIES = 2;
const JOB_POLL_SECONDS = 5;
const JOB_POLL_MAX = 60; // up to ~5 min of durable polling
const TOOL_RESULT_CAP = 8000;

export interface ApprovalRequest {
  toolUseId: string;
  serviceId: string;
  action: ApprovalAction;
  input: unknown;
  draftPreview: string;
  kind?: "send" | "budget"; // "budget" = the per-run budget raise/stop pause (W-S M7)
  budget?: { spentUsd: number; budgetUsd: number; estimateUsd: number };
}
/** The engine-side decision the brain consumes. Keep the `action` union in sync with the transport
 *  mirror in src/lib/runtime/types.ts (this one narrows `payload` to `{ input? }` for the edit path). */
export interface ApprovalDecision {
  action: "approve" | "edit" | "regenerate" | "reject";
  payload?: { input?: unknown };
}

export interface RunAgentDeps {
  runId: string;
  userId: string;
  goal: string;
  seedServiceId?: string;
  seedBackendProviderId?: string; // user-picked provider/endpoint for the seeded service (catalog selection)
  parentRunId?: string; // follow-up: replay this prior run's session as conversation context
  assetUrls?: string[];
  bundleRecipe?: string; // pre-compiled "/<slug>" recipe text (spec §6.2/§6.3)
  mcpToken: string;
  origin: string;
  model?: string;
  maxTurns?: number;
  waitForApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  sleep: (seconds: number) => Promise<void>;
}

export interface RunAgentResult {
  status: "complete" | "capped" | "failed";
  turns: number;
  toolCalls: number;
}

type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type RunInput = { serviceId: string; operation?: string; backendProviderId?: string; input?: unknown; model?: string };

function isToolUse(b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock {
  return b.type === "tool_use";
}
function rsContent(input: RunInput) {
  return {
    serviceId: input.serviceId,
    operation: input.operation ?? null,
    backendProviderId: input.backendProviderId ?? null,
    input: input.input ?? null,
  };
}
/** Pin the user-selected provider/endpoint for the SEEDED service when the model didn't pick one itself.
 *  Applied BEFORE seq/stepKey hashing so the choice is part of idempotency and the replay is stable. The
 *  model may still override by passing its own backendProviderId; only the seeded serviceId is auto-pinned. */
function pinBackend(ri: RunInput, deps: RunAgentDeps): RunInput {
  if (deps.seedBackendProviderId && ri.serviceId === deps.seedServiceId && !ri.backendProviderId) {
    return { ...ri, backendProviderId: deps.seedBackendProviderId };
  }
  return ri;
}
function cap(s: string): string {
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + "…[truncated]" : s;
}
/** A detectable async-job envelope from run_service (so we poll get_result). */
function jobId(structured: unknown): string | null {
  const s = structured as { jobId?: string; status?: string; async?: boolean; kind?: string } | null;
  if (s && typeof s.jobId === "string" && (s.kind === "job" || s.async || s.status === "pending")) return s.jobId;
  return null;
}

/** Spend-limit / scope rejection codes — surfaced as an in-chat notice linking to limits (W9). */
const LIMIT_CODES = new Set(["monthly_limit", "per_call_max", "rule", "scope"]);

/**
 * Reconstruct ONE prior (completed) run's conversation as Anthropic messages: the user's goal, every
 * assistant turn + its tool results, then the closing summary. Always ends on an ASSISTANT turn so
 * concatenating runs (and appending the new user turn) keeps user/assistant alternation valid. Read-only
 * — prior runs are terminal, so nothing is re-executed and no charge is incurred.
 */
async function reconstructRunMessages(runId: string): Promise<Anthropic.MessageParam[]> {
  const [run, steps] = await Promise.all([getRun(runId), getSteps(runId)]);
  const out: Anthropic.MessageParam[] = [{ role: "user", content: run?.goal?.trim() || "(earlier request)" }];
  const plans = steps
    .filter((s) => s.kind === "tool_call" && (s.data as { calls?: unknown }).calls)
    .map((s) => s.data as { turn: number; assistant: Anthropic.ContentBlockParam[]; calls: PlanCall[] })
    .sort((a, b) => a.turn - b.turn);
  const resultByToolUse = new Map<string, { structured: unknown; isError: boolean }>();
  for (const s of steps) {
    const d = s.data as { toolUseId?: string; structured?: unknown; isError?: boolean };
    if (d?.toolUseId && "structured" in d) resultByToolUse.set(d.toolUseId, { structured: d.structured, isError: !!d.isError });
  }
  for (const plan of plans) {
    out.push({ role: "assistant", content: plan.assistant });
    out.push({
      role: "user",
      content: plan.calls.map((c) => {
        const r = resultByToolUse.get(c.toolUseId);
        return {
          type: "tool_result" as const,
          tool_use_id: c.toolUseId,
          content: cap(JSON.stringify(r?.structured ?? null)),
          is_error: !!r?.isError,
        };
      }),
    });
  }
  // Closing summary: finishText persists a kind:"text" step with NO `turn` (per-turn texts carry one).
  const finalText = steps
    .filter((s) => s.kind === "text" && (s.data as { turn?: number }).turn === undefined)
    .map((s) => (s.data as { text?: string }).text)
    .filter((t): t is string => !!t)
    .pop();
  out.push({ role: "assistant", content: finalText || "(completed the previous request)" });
  return out;
}

/** Walk the parent lineage to the session root (oldest-first) and replay each prior run's conversation,
 *  so a follow-up agent continues with full context (it can reference/edit earlier outputs + data). */
async function loadPriorSessionMessages(parentRunId: string): Promise<Anthropic.MessageParam[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = parentRunId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = (await getRun(cur))?.parentRunId;
  }
  chain.reverse(); // root → … → immediate parent (chronological)
  const out: Anthropic.MessageParam[] = [];
  for (const id of chain) out.push(...(await reconstructRunMessages(id)));
  return out;
}

export async function runAgent(deps: RunAgentDeps): Promise<RunAgentResult> {
  const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    // Explicit timeout DISABLES the SDK's non-streaming "10-minute" guard (it only fires when timeout is
    // null), so a future max_tokens bump can't silently break every run. We run inside a durable Trigger
    // task (maxDuration: none), and real completions are 1-3 min, so a 20-min ceiling is safe headroom.
    timeout: 20 * 60 * 1000,
  });
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTurns = deps.maxTurns ?? MAX_TURNS;
  const mcp = await connectMcp(deps.origin, deps.mcpToken);
  let toolCalls = 0;

  try {
    // ---- Rehydrate from durable transcript ----
    const steps = await getSteps(deps.runId);
    const plans = steps
      .filter((s) => s.kind === "tool_call" && (s.data as { calls?: unknown }).calls)
      .map((s) => s.data as { turn: number; assistant: Anthropic.ContentBlockParam[]; calls: PlanCall[] })
      .sort((a, b) => a.turn - b.turn);
    const resultByToolUse = new Map<string, { structured: unknown; isError: boolean }>();
    for (const s of steps) {
      const d = s.data as { toolUseId?: string; structured?: unknown; isError?: boolean };
      if (d?.toolUseId && "structured" in d) resultByToolUse.set(d.toolUseId, { structured: d.structured, isError: !!d.isError });
    }

    // Follow-up runs continue the chat session: replay the prior runs' full conversation as context so
    // the agent can reference/edit earlier outputs ("edit that image", "email those employees"). Loaded on
    // every attempt (context-only — no execution, no seq impact) so a crash-retry rebuilds the same prefix
    // before the current run's own rehydration (below) appends its committed turns.
    const priorMessages = deps.parentRunId ? await loadPriorSessionMessages(deps.parentRunId) : [];
    const messages: Anthropic.MessageParam[] = [
      ...priorMessages,
      {
        role: "user",
        content: buildSeedMessage({
          goal: deps.goal,
          seedServiceId: deps.seedServiceId,
          seedBackendProviderId: deps.seedBackendProviderId,
          assetUrls: deps.assetUrls,
          bundleRecipe: deps.bundleRecipe,
        }),
      },
    ];
    // prior committed run_service contentHash → count (for seq).
    const priorHash = new Map<string, number>();
    let turn = 0;

    // ---- Per-run budget gate (W-S M7) ----
    // Best-effort next-call estimate = max per-call cost seen this run (no extra MCP round-trip).
    // budgetUsd/providerCostUsd are read FRESH from the RunDoc each gate (authoritative + crash-safe; a
    // "raise" persists via patchRun). When the next paid step would exceed the budget, pause for a
    // raise-or-stop approval reusing the waitpoint. Returns "proceed" or "stop" (skip this paid call).
    let maxCostUsd = 0;
    const budgetGate = async (toolUseId: string): Promise<"proceed" | "stop"> => {
      const run = await getRun(deps.runId);
      const budget = run?.budgetUsd ?? 0;
      if (!(budget > 0)) return "proceed"; // no per-run budget configured → inert
      const spent = run?.providerCostUsd ?? 0;
      if (spent + maxCostUsd <= budget) return "proceed"; // within budget (best-effort)
      await persistStepOnce({
        runId: deps.runId,
        userId: deps.userId,
        kind: "approval",
        marker: `budget:${toolUseId}`,
        data: { toolUseId, action: "budget", budget: { spentUsd: spent, budgetUsd: budget, estimateUsd: maxCostUsd } },
      });
      const decision = await deps.waitForApproval({
        toolUseId,
        serviceId: "",
        action: "budget",
        input: null,
        draftPreview: "",
        kind: "budget",
        budget: { spentUsd: spent, budgetUsd: budget, estimateUsd: maxCostUsd },
      });
      if (decision.action === "approve") {
        const inc = Number(process.env.MASTERKEY_DEFAULT_RUN_BUDGET_USD ?? "5") || 5;
        await patchRun(deps.runId, { budgetUsd: budget + inc });
        return "proceed";
      }
      return "stop"; // reject (or edit/regenerate) → skip this paid call
    };

    for (const plan of plans) {
      messages.push({ role: "assistant", content: plan.assistant });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const c of plan.calls) {
        let res: { structured: unknown; isError: boolean; costUsd?: number } | undefined =
          resultByToolUse.get(c.toolUseId);
        if (!res) {
          // Crash mid-turn: re-execute this in-flight call. Same stepKey → MCP dedupes (no double-charge).
          res = await executeCall(c, mcp, deps, budgetGate);
          toolCalls++;
          if (res.costUsd && res.costUsd > maxCostUsd) maxCostUsd = res.costUsd;
          await persistResult(deps, plan.turn, c, res);
        }
        toolResults.push({ type: "tool_result", tool_use_id: c.toolUseId, content: cap(JSON.stringify(res.structured ?? null)), is_error: res.isError });
        if (c.stepKey) priorHash.set(c.contentHash!, (priorHash.get(c.contentHash!) ?? 0) + 1);
      }
      messages.push({ role: "user", content: toolResults });
      turn = plan.turn + 1;
    }

    // ---- Main loop ----
    let maxTokRetries = 0;
    while (turn < maxTurns) {
      // Heartbeat the lease while actively executing (the reaper pre-filters on this; v2.2 / W11).
      await patchRun(deps.runId, { leaseISO: new Date().toISOString() });
      const resp = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: RUNNER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: MCP_TOOLS,
        messages,
      });

      if (resp.stop_reason === "max_tokens") {
        if (maxTokRetries++ >= MAX_MAXTOKENS_RETRIES) {
          await finishText(deps, "A single step produced too much output to complete (likely a large result or report in one call). Stopping — try a smaller batch, or start a fresh run seeded with the results so far.");
          await patchRun(deps.runId, { status: "failed" });
          return { status: "failed", turns: turn, toolCalls };
        }
        continue; // truncated tool_use → do NOT execute the partial; retry the turn (W-S M11)
      }
      maxTokRetries = 0;

      const toolUses = resp.content.filter(isToolUse) as ToolUse[];
      const assistantText = resp.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n").trim();

      if (toolUses.length === 0) {
        // Done.
        if (assistantText) await finishText(deps, assistantText);
        await mirrorRunOutputs(deps.runId, deps.userId); // re-host media → Blob for a durable library (W10)
        await logCostInvariant(deps.runId); // 2.4
        await persistStepOnce({ runId: deps.runId, userId: deps.userId, kind: "done", marker: `done:${turn}`, data: { turn } });
        await patchRun(deps.runId, { status: "complete" });
        return { status: "complete", turns: turn, toolCalls };
      }

      // Compute seq/stepKey for run_service calls (from prior + within-turn ordinal) BEFORE executing.
      const withinTurn = new Map<string, number>();
      const calls: PlanCall[] = toolUses.map((tu) => {
        if (tu.name === "run_service") {
          const ri = pinBackend(tu.input as RunInput, deps); // auto-pin the seeded service's chosen backend
          const h = contentHash(rsContent(ri));
          const ordinal = withinTurn.get(h) ?? 0;
          withinTurn.set(h, ordinal + 1);
          const seq = (priorHash.get(h) ?? 0) + ordinal;
          return { toolUseId: tu.id, name: tu.name, input: ri, contentHash: h, seq, stepKey: stepKey(deps.runId, rsContent(ri), seq) };
        }
        return { toolUseId: tu.id, name: tu.name, input: tu.input };
      });

      // Commit the plan (assistant content + calls) BEFORE any tool runs.
      await persistPlanStep({ runId: deps.runId, userId: deps.userId, turn, data: { turn, assistant: resp.content, calls } });
      if (assistantText) {
        await persistStepOnce({ runId: deps.runId, userId: deps.userId, kind: "text", marker: `text:${turn}`, data: { text: assistantText, turn } });
      }
      messages.push({ role: "assistant", content: resp.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const c of calls) {
        const res = await executeCall(c, mcp, deps, budgetGate);
        toolCalls++;
        if (res.costUsd && res.costUsd > maxCostUsd) maxCostUsd = res.costUsd;
        await persistResult(deps, turn, c, res);
        toolResults.push({ type: "tool_result", tool_use_id: c.toolUseId, content: cap(JSON.stringify(res.structured ?? null)), is_error: res.isError });
        if (c.stepKey) priorHash.set(c.contentHash!, (priorHash.get(c.contentHash!) ?? 0) + 1);
      }
      messages.push({ role: "user", content: toolResults });
      turn++;
    }

    await mirrorRunOutputs(deps.runId, deps.userId); // re-host media → Blob for a durable library (W10)
    await logCostInvariant(deps.runId); // 2.4
    // 6.1: never end blank — emit a "what I tried and why" closing summary for the capped run.
    const cappedSummary = await buildAttemptSummary(deps);
    await finishText(deps, `I reached this run's step limit before producing a finished result. ${cappedSummary} You can refine or simplify the request and run again, or try a different approach.`);
    await persistStepOnce({ runId: deps.runId, userId: deps.userId, kind: "done", marker: `done:capped`, data: { turn, capped: true } });
    await patchRun(deps.runId, { status: "capped" });
    return { status: "capped", turns: turn, toolCalls };
  } catch (e) {
    // 6.1: surface a readable closing summary alongside the raw error.
    const failSummary = await buildAttemptSummary(deps).catch(() => "");
    await persistStepOnce({
      runId: deps.runId,
      userId: deps.userId,
      kind: "error",
      marker: `error:${Date.now()}`,
      data: { message: `This run hit an error and stopped. ${failSummary} (${e instanceof Error ? e.message : String(e)})` },
    }).catch(() => {});
    await patchRun(deps.runId, { status: "failed" }).catch(() => {});
    return { status: "failed", turns: 0, toolCalls };
  } finally {
    await mcp.close().catch(() => {});
  }
}

interface PlanCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  contentHash?: string;
  seq?: number;
  stepKey?: string;
}

async function finishText(deps: RunAgentDeps, text: string): Promise<void> {
  await persistStepOnce({ runId: deps.runId, userId: deps.userId, kind: "text", marker: `final:${text.slice(0, 24)}:${text.length}`, data: { text } });
}

/**
 * RUN_RELIABILITY_SPEC 6.1: build a readable "what I tried and why it didn't finish" summary from the
 * persisted steps, so a capped/failed run never ends blank. Deterministic (no extra LLM call): pairs
 * run_service tool_calls (serviceId) with their results (ok / error code) by toolUseId.
 */
async function buildAttemptSummary(deps: RunAgentDeps): Promise<string> {
  let steps: Awaited<ReturnType<typeof getSteps>> = [];
  try {
    steps = await getSteps(deps.runId);
  } catch {
    return "";
  }
  const svcByTool = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "tool_call") continue;
    const calls = (s.data as { calls?: { toolUseId: string; name: string; input?: { serviceId?: string } }[] }).calls ?? [];
    for (const c of calls) if (c.name === "run_service" && c.input?.serviceId) svcByTool.set(c.toolUseId, c.input.serviceId);
  }
  const attempts: string[] = [];
  for (const s of steps) {
    if (s.kind !== "result") continue;
    const d = s.data as { toolName?: string; toolUseId?: string; isError?: boolean; structured?: { error?: boolean; code?: string; message?: string } };
    if (d.toolName !== "run_service") continue;
    const svc = svcByTool.get(d.toolUseId ?? "") ?? "a service";
    if (d.isError || d.structured?.error) attempts.push(`${svc} (failed: ${d.structured?.code ?? d.structured?.message ?? "error"})`);
    else attempts.push(`${svc} (ok)`);
  }
  return attempts.length ? `Services attempted: ${attempts.join("; ")}.` : "No services completed successfully.";
}

/** RUN_RELIABILITY_SPEC 2.4: cheap invariant guard — `RunDoc.providerCostUsd` must equal the sum of
 * the run's SETTLED ledger rows (the derived single-source-of-truth from 2.1). Logs a warning on any
 * drift so a future regression that re-introduces an independent cost writer is caught early. Runs once
 * at run completion. Best-effort; never throws. */
async function logCostInvariant(runId: string): Promise<void> {
  try {
    const [run, ledgerSum] = await Promise.all([getRun(runId), settledCostForRun(runId)]);
    const runCost = run?.providerCostUsd ?? 0;
    if (Math.abs(runCost - ledgerSum) > 1e-6) {
      console.warn(`[run-cost-invariant] DRIFT run=${runId} RunDoc.providerCostUsd=${runCost} settledLedger=${ledgerSum}`);
    }
  } catch {
    /* observability only — never affect the run */
  }
}

async function persistResult(
  deps: RunAgentDeps,
  turn: number,
  c: PlanCall,
  res: { structured: unknown; isError: boolean; costUsd?: number },
): Promise<void> {
  await persistStepOnce({
    runId: deps.runId,
    userId: deps.userId,
    kind: "result",
    marker: `result:${c.toolUseId}`,
    data: { turn, toolUseId: c.toolUseId, toolName: c.name, structured: res.structured, isError: res.isError },
    ...(c.stepKey ? { stepKey: c.stepKey } : {}),
  });
  // RUN_RELIABILITY_SPEC 2.1: RunDoc.providerCostUsd is DERIVED from the run's SETTLED ledger rows
  // (single source of truth: the ledger), not accumulated from per-step structured costs. This counts
  // the sync submit + async submit + every paid poll and stays correct even when a job is capped/
  // never completes (the incident's $0.02-vs-$0.94 gap). Idempotent + crash-safe to recompute.
  if (c.name === "run_service") {
    await patchRun(deps.runId, { providerCostUsd: await settledCostForRun(deps.runId) });
  }
}

/** Execute one tool call: approval gate (run_service only) → MCP call → job-poll. */
async function executeCall(
  c: PlanCall,
  mcp: Awaited<ReturnType<typeof connectMcp>>,
  deps: RunAgentDeps,
  budgetGate?: (toolUseId: string) => Promise<"proceed" | "stop">,
): Promise<{ structured: unknown; isError: boolean; costUsd?: number }> {
  const name = c.name as McpToolName;

  if (name !== "run_service") {
    const r = await callMcpTool(mcp, name, c.input);
    return { structured: r.structured, isError: r.isError };
  }

  let ri = c.input as RunInput;

  // Per-run budget gate (W-S M7) — BEFORE the send gate and the paid call. If the next paid step would
  // exceed the run's budget, this pauses for a raise-or-stop approval; "stop" skips this paid call.
  if (budgetGate && (await budgetGate(c.toolUseId)) === "stop") {
    return {
      structured: {
        budgetExceeded: true,
        note: "This run reached its budget and it was not raised. This step was skipped — do not retry it; summarize what's completed and finish.",
      },
      isError: false,
    };
  }

  // Approval gate (harness-decided, default-deny).
  const verdict = classifyApproval({ serviceId: ri.serviceId, operation: ri.operation, toolInput: ri.input });
  if (verdict.needsApproval) {
    const draftPreview = cap(JSON.stringify(ri.input ?? {}));
    await persistStepOnce({
      runId: deps.runId,
      userId: deps.userId,
      kind: "approval",
      marker: `approval:${c.toolUseId}`,
      data: { toolUseId: c.toolUseId, serviceId: ri.serviceId, action: verdict.action, draftPreview },
    });
    const decision = await deps.waitForApproval({ toolUseId: c.toolUseId, serviceId: ri.serviceId, action: verdict.action, input: ri.input, draftPreview });
    if (decision.action === "reject") {
      return { structured: { declined: true, note: "User declined to send. Do not retry; consider an alternative or finish." }, isError: false };
    }
    if (decision.action === "regenerate") {
      return { structured: { regenerate: true, note: "User asked to revise this draft. Produce a new version and resubmit for approval." }, isError: false };
    }
    if (decision.action === "edit" && decision.payload?.input != null) {
      // Re-validate the edited input against the same gate (basic C6; full closed-allowlist is a future hardening).
      ri = { ...ri, input: decision.payload.input };
      const recheck = classifyApproval({ serviceId: ri.serviceId, operation: ri.operation, toolInput: ri.input });
      if (!recheck.needsApproval) {
        return { structured: { error: "edit changed the action class; a fresh approval is required" }, isError: true };
      }
    }
  }

  // Execute the paid call with the seq-bearing idempotency key.
  const args: Record<string, unknown> = { serviceId: ri.serviceId, input: ri.input ?? {} };
  if (ri.operation) args.operation = ri.operation;
  if (ri.backendProviderId) args.backendProviderId = ri.backendProviderId;
  if (ri.model) args.model = ri.model;
  let r = await callMcpTool(mcp, "run_service", args, c.stepKey);

  // Async job? Poll get_result with durable waits ($0 idle) until done.
  let jid = jobId(r.structured);
  let polls = 0;
  while (jid && polls++ < JOB_POLL_MAX) {
    await persistStepOnce({
      runId: deps.runId,
      userId: deps.userId,
      kind: "pending",
      marker: `pending:${c.toolUseId}`,
      data: { toolUseId: c.toolUseId, jobId: jid, serviceName: ri.serviceId },
    });
    await deps.sleep(JOB_POLL_SECONDS);
    r = await callMcpTool(mcp, "get_result", { jobId: jid });
    jid = jobId(r.structured);
  }

  // W9 — surface a spend-limit / scope rejection as an in-chat notice (no charge occurred).
  if (r.isError) {
    const code = (r.structured as { code?: string })?.code;
    if (code && LIMIT_CODES.has(code)) {
      const msg = (r.structured as { message?: string })?.message ?? "This call would exceed your spend limit.";
      await persistStepOnce({
        runId: deps.runId,
        userId: deps.userId,
        kind: "warning",
        marker: `limit:${c.toolUseId}`,
        data: { text: msg, limit: true, code },
      });
    }
  }

  const cost = (r.structured as { providerCostUsd?: number })?.providerCostUsd;
  return { structured: r.structured, isError: r.isError, costUsd: typeof cost === "number" ? cost : undefined };
}
