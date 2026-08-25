// Masterkey — send-approval classifier (W6 / W-S M4). HARNESS-side, default-deny. The model NEVER
// self-classifies a send as safe — this function decides whether a run_service call must pause for
// human approval before executing. Curated `needsApproval` is honored from THREE places, because the
// registry records it in three: `Operation.needsApproval`, `Backend.needsApproval`, and
// `ServiceUsage.needsApproval` (what a Registry-QA pay-test writes once it learns an endpoint really is
// outward). Beyond those the live gate is: sensitive category OR a recipient-class field in the input OR an
// unresolvable service. Fetch/generate/host/analyze run autonomously.
//
// The usage-level read was added 2026-07-26 after an audit found the gate ignored it: 47 services carried
// `usage.needsApproval`, and 4 had NO Operation/Backend flag AND a non-sensitive category — including
// `didit-phone-otp-send` / `didit-email-otp-send`, which deliver a real OTP to a real person and were
// relying on the recipient-field heuristic happening to fire. QA's verdict is now authoritative, so a
// future pay-test that marks a service outward arms the gate with no separate curation step.
//
// ⚠️ Residual gap: an outward op that NO layer has flagged, in a non-sensitive category, whose input has no
// recipient-class field (e.g. "publish content" tagged web-automation). Closed only by curation.

import { findServiceById } from "@/lib/registry";
import type { ApprovalAction } from "@/lib/chat/types";

// Categories that are outward/irreversible by nature (registry slugs; "social" reserved/future).
const SENSITIVE_CATEGORIES = new Set(["communication", "ecommerce", "payments-billing", "social"]);

// Unambiguous send/recipient fields — any non-empty value means an outward target.
const STRONG_RECIPIENT_KEYS = new Set([
  "cc", "bcc", "recipient", "recipients", "to_email", "toemail", "email", "emails",
  "phone_number", "phonenumber", "msisdn", "fax", "mailing_address",
]);
// Ambiguous fields that ALSO appear in non-send calls (date ranges, pagination, transfers, geo): treat
// as a recipient ONLY when the VALUE looks like one (email/phone). Fixes the false "send email" approval
// when a news search passes {"to":"2026-06-09","from":"2026-06-08"} as a date range.
const WEAK_RECIPIENT_KEYS = new Set([
  "to", "dest", "destination", "target", "channel", "number", "phone", "sms", "address", "postal",
]);

// A value that actually looks like a send target: an email, or a phone-length digit string. A date
// (2026-06-09), a small number (page size), or a short word is NOT a recipient.
function looksLikeRecipient(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(looksLikeRecipient);
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || /^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  if (s.includes("@")) return true;
  return (s.match(/\d/g) ?? []).length >= 7;
}

export interface ApprovalClassification {
  needsApproval: boolean;
  reason: "op_flag" | "usage_flag" | "category" | "recipient_field" | "unknown_service" | "autonomous";
  action: ApprovalAction;
}

function scanForRecipient(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (Array.isArray(value)) return value.some((v) => scanForRecipient(v, depth + 1));
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (v != null && v !== "") {
        if (STRONG_RECIPIENT_KEYS.has(key)) return true; // unambiguous send field
        if (WEAK_RECIPIENT_KEYS.has(key) && looksLikeRecipient(v)) return true; // ambiguous → check the value
      }
      if (scanForRecipient(v, depth + 1)) return true;
    }
  }
  return false;
}

function safeBlob(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input ?? {});
  } catch {
    return "";
  }
}

function inferAction(category: string, input: unknown): ApprovalAction {
  const c = category.toLowerCase();
  if (c === "payments-billing" || c === "ecommerce") return "purchase";
  if (c === "social") return "publish";
  const blob = safeBlob(input).toLowerCase();
  if (/\bcall\b|voice|dial/.test(blob)) return "call";
  if (/postal|postcard|\bletter\b|physical mail|mailing_address/.test(blob)) return "mail";
  if (/\bsms\b|text message|msisdn/.test(blob)) return "sms";
  return "email";
}

/** Decide whether this intended run_service call must pause for approval. Default-DENY when unsure. */
export function classifyApproval(input: {
  serviceId: string;
  operation?: string;
  toolInput: unknown;
}): ApprovalClassification {
  const svc = findServiceById(input.serviceId);
  // Can't resolve → default-deny (never let an unknown service act outward unreviewed).
  if (!svc) return { needsApproval: true, reason: "unknown_service", action: "publish" };

  // 1) Curated per-target flag (W-S M4) — honored the moment the registry is enriched. Checks the named
  //    operation if given; otherwise ANY flagged operation OR backend on the service. (Most api-kind
  //    services have empty operations[] and run via backends[], so the flag must be readable there too —
  //    previously only operations[] was checked, making a backend-level needsApproval dead.)
  const op = input.operation ? svc.operations.find((o) => o.name === input.operation) : undefined;
  const curatedOutward = op
    ? !!op.needsApproval
    : svc.operations.some((o) => o.needsApproval) || (svc.backends?.some((b) => b.needsApproval) ?? false);
  if (curatedOutward) {
    return { needsApproval: true, reason: "op_flag", action: inferAction(svc.category, input.toolInput) };
  }

  // 1b) Service-level Registry-QA verdict (`ServiceUsage.needsApproval`). A pay-test is where we actually
  //     LEARN an endpoint is outward — it sent a real SMS, mailed a real letter — and QA writes that here,
  //     a DIFFERENT field from the Operation/Backend flags above. Reading it makes the QA sweep the single
  //     place a human decides "this one is irreversible", instead of requiring a second, easily-forgotten
  //     curation edit to arm the harness.
  if (svc.usage?.needsApproval) {
    return { needsApproval: true, reason: "usage_flag", action: inferAction(svc.category, input.toolInput) };
  }

  // 2) Sensitive category → approval.
  if (SENSITIVE_CATEGORIES.has(svc.category)) {
    return { needsApproval: true, reason: "category", action: inferAction(svc.category, input.toolInput) };
  }

  // 3) Recipient-class field present → approval (catches a mis-categorized send).
  if (scanForRecipient(input.toolInput)) {
    return { needsApproval: true, reason: "recipient_field", action: inferAction(svc.category, input.toolInput) };
  }

  return { needsApproval: false, reason: "autonomous", action: "email" };
}
