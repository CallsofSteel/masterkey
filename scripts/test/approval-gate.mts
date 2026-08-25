// Masterkey — approval-gate tests (W6 / W-S M4).
//
// Run: npx tsx scripts/test/approval-gate.mts
// Money-free and network-free: `classifyApproval` only reads the local registry.
//
// This gate is the thing standing between an autonomous run and a real SMS / a mailed letter / a purchase,
// so its layers get asserted rather than assumed. It is default-deny by design: every ambiguous case must
// come back `needsApproval: true`.
//
// Regression locked down here (found 2026-07-26): the registry records "this is outward" in THREE fields —
// Operation.needsApproval, Backend.needsApproval, and ServiceUsage.needsApproval — and the classifier read
// only the first two. 47 services carried the usage flag; 4 had no Operation/Backend flag AND a
// non-sensitive category, so they were gated only by the recipient-field heuristic firing by luck. Two of
// them send a real OTP to a real person.

import { classifyApproval } from "../../src/lib/agent/approval-rules";
import { findServiceById } from "../../src/lib/registry";

let passed = 0;
let failed = 0;

function check(name: string, got: { needsApproval: boolean; reason: string }, wantApproval: boolean, wantReason?: string) {
  const ok = got.needsApproval === wantApproval && (!wantReason || got.reason === wantReason);
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}\n      got  needsApproval=${got.needsApproval} reason=${got.reason}\n      want needsApproval=${wantApproval}${wantReason ? ` reason=${wantReason}` : ""}`);
  }
}

const cls = (serviceId: string, toolInput: unknown, operation?: string) =>
  classifyApproval({ serviceId, toolInput, ...(operation ? { operation } : {}) });

// --- THE REGRESSION: ServiceUsage.needsApproval must gate ---------------------------------------
// Both deliver a one-time code to a real phone/email and sit in the NON-sensitive `auth-identity`
// category, so no other layer reliably catches them.
for (const id of ["didit-phone-otp-send", "didit-email-otp-send"]) {
  if (findServiceById(id)) check(`${id} (usage flag, empty input)`, cls(id, {}), true, "usage_flag");
  else console.log(`  – skipped ${id} (not in registry)`);
}

// --- Layer 1: curated Operation / Backend flags -------------------------------------------------
if (findServiceById("agentmail")) {
  check("agentmail send (operation flag)", cls("agentmail", { to: "a@b.com" }), true);
  check("agentmail named op", cls("agentmail", {}, "Send Message"), true, "op_flag");
}
if (findServiceById("postalform-mail-letter")) {
  check("postalform mail letter (backend flag)", cls("postalform-mail-letter", {}), true);
}

// --- Layer 2: sensitive category ----------------------------------------------------------------
// Resolved dynamically so the test doesn't rot when a specific id is recurated.
const SENSITIVE = new Set(["communication", "ecommerce", "payments-billing", "social"]);
const sensitiveId = ["send-sms", "agentmail", "stablemerch-custom-merch"].find((i) => SENSITIVE.has(findServiceById(i)?.category ?? ""));
if (sensitiveId) check(`${sensitiveId} (sensitive category)`, cls(sensitiveId, {}), true);

// --- Layer 3: recipient-field heuristic ---------------------------------------------------------
if (findServiceById("serper-web-search")) {
  check("plain search runs autonomously", cls("serper-web-search", { q: "x402 protocol" }), false, "autonomous");
  check("search carrying an email → gated", cls("serper-web-search", { q: "x", to: "a@b.com" }), true, "recipient_field");
  check("search carrying a phone → gated", cls("serper-web-search", { q: "x", phone: "+15551234567" }), true, "recipient_field");
  // The weak-key value check: a news query's {to,from} DATE range must NOT read as a recipient.
  check("date range is not a recipient", cls("serper-web-search", { q: "x", to: "2026-06-09", from: "2026-06-08" }), false, "autonomous");
  // Nested payloads still get scanned.
  check("nested recipient is found", cls("serper-web-search", { q: "x", opts: { deep: { bcc: "a@b.com" } } }), true, "recipient_field");
}
if (findServiceById("brave-search")) {
  check("brave search runs autonomously", cls("brave-search", { q: "hello" }), false, "autonomous");
}

// --- Layer 4: default-deny on an unresolvable service -------------------------------------------
// This is also the dead-bundle-pin failure mode (see scripts/registry/verify-bundle-pins.mjs).
check("unknown service → deny", cls("definitely-not-a-real-service", { q: "x" }), true, "unknown_service");
check("dead pin 'serper' → deny", cls("serper", { q: "x" }), true, "unknown_service");

console.log(`\napproval-gate tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
