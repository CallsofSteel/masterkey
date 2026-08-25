// Masterkey — durable step idempotency key derivation (server-only). THE input to the MCP's
// double-charge guard (run_idempotency). Key = `${runId}:sha256(JCS(content)):seq=N` where:
//   • JCS = RFC 8785 canonical JSON (recursive key sort + canonical numbers) via the vetted
//     `canonicalize` lib — a naive JSON.stringify re-orders keys across LLM replay → different hash
//     → the MCP would re-fire a paid call (double-charge). See WEB_SPEC §0 / W4 / Appendix W-S C2.
//   • seq = a DURABLE per-content occurrence counter derived from the persisted pre-execution plan
//     (NOT idx, NOT a wall-clock/read-at-issue count). seq is computed by the brain (see seq.ts);
//     this module only stamps it into the key. A crash-replay re-derives the SAME seq → MCP dedupes;
//     an intentional duplicate gets seq+1 → pays again.
//
// content = {serviceId, operation, backendProviderId, input}. operation/backendProviderId are
// normalized undefined→null so "absent" and "explicit null" hash identically (stable across replay).

import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

export interface StepContent {
  serviceId: string;
  operation?: string | null;
  backendProviderId?: string | null;
  input: unknown;
}

/** RFC 8785 canonical JSON. Throws on non-serializable input (undefined/function/symbol at root). */
export function canonicalJson(value: unknown): string {
  const c = canonicalize(value);
  if (c === undefined) {
    throw new Error("canonicalJson: value is not JSON-serializable");
  }
  return c;
}

function normalize(parts: StepContent): Record<string, unknown> {
  return {
    serviceId: parts.serviceId,
    operation: parts.operation ?? null,
    backendProviderId: parts.backendProviderId ?? null,
    input: parts.input ?? null,
  };
}

/** sha256 over the canonical content — stable across key-order/number-form variation. */
export function contentHash(parts: StepContent): string {
  return createHash("sha256").update(canonicalJson(normalize(parts)), "utf8").digest("hex");
}

/** The seq-bearing idempotency key the brain passes to run_service. */
export function stepKey(runId: string, parts: StepContent, seq: number): string {
  return `${runId}:${contentHash(parts)}:seq=${seq}`;
}
