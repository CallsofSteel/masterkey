/**
 * qa-reconcile.mjs — deterministically fold a batch's structured results into the QA source-of-truth.
 *
 * Reads the workflow's normalized results (data/registry/qa-batch-<N>-results.json: [{phaseA, phaseB}])
 * and updates, single-threaded (no races):
 *   • data/registry/qa-checklist.json  — per-endpoint status/testedAt/costUsd/testedVia/notes
 *   • data/registry/qa-ledger.json     — adds an endpoint-keyed `endpoints` record (idempotency)
 * Then prints a summary + the batch's total spend.  (Curation patches, verifier briefs, and the batch
 * report are authored separately — they carry judgment, e.g. drop decisions and salvage paths.)
 *
 * Status mapping (classification → checklist status):
 *   free-ok | verified                         → verified
 *   verified-with-quirks + phaseB PASS|SKIP     → verified
 *   verified-with-quirks + phaseB FAIL          → needs-review   (doc not yet good enough; re-queue)
 *   broken                                       → broken
 *   over-cap                                     → over-cap
 *   needs-input                                  → needs-input
 *
 * Usage: node scripts/registry/qa-reconcile.mjs --batch=1 [--results=<path>]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const argv = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const BATCH = String(argv.batch ?? "1");
const RESULTS = argv.results ? String(argv.results) : `data/registry/qa-batch-${BATCH}-results.json`;

const CHECKLIST = path.join(ROOT, "data/registry/qa-checklist.json");
const LEDGER = path.join(ROOT, "data/registry/qa-ledger.json");

const results = JSON.parse(fs.readFileSync(path.join(ROOT, RESULTS), "utf8"));
const checklist = JSON.parse(fs.readFileSync(CHECKLIST, "utf8"));
const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
if (!ledger.endpoints) ledger.endpoints = {};

const byKey = new Map(checklist.endpoints.map((e) => [e.key, e]));
const today = new Date().toISOString().slice(0, 10);

function statusFor(a, b) {
  const c = a.classification;
  if (c === "free-ok" || c === "verified") return "verified";
  if (c === "verified-with-quirks") return b && b.verdict === "FAIL" ? "needs-review" : "verified";
  if (c === "broken") return "broken";
  if (c === "over-cap") return "over-cap";
  if (c === "needs-input") return "needs-input";
  return "todo";
}

let totalCost = 0;
const summary = [];
for (const r of results) {
  const a = r.phaseA || {};
  const b = r.phaseB || {};
  const row = byKey.get(a.key);
  const status = statusFor(a, b);
  const costA = Number(a.costUsd || 0);
  const costB = Number(b.costUsd || 0);
  totalCost += costA + costB;

  if (row) {
    row.status = status;
    row.testedAt = today;
    row.costUsd = costA + costB;
    row.testedVia = `qa-batch-${BATCH}`;
    row.notes = `${a.classification}${b && b.verdict !== "SKIP" ? " / phaseB:" + b.verdict : ""}`;
  }

  ledger.endpoints[a.key] = {
    status,
    classification: a.classification,
    costUsd: costA + costB,
    paid: !!a.paid,
    confirmed: a.confirmed ?? null,
    txHash: a.txHash ?? null,
    testedUrl: row ? row.url : null,
    phaseB: b ? b.verdict : null,
    testedAt: today,
    batchId: `batch-${BATCH}`,
  };

  summary.push({ key: a.key, class: a.classification, phaseB: b ? b.verdict : "-", status, cost: costA + costB });
}

// recompute checklist totals
const countBy = (pred) => checklist.endpoints.filter(pred).length;
checklist.totals = {
  endpoints: checklist.endpoints.length,
  services: new Set(checklist.endpoints.map((e) => e.serviceId)).size,
  verified: countBy((e) => e.status === "verified"),
  broken: countBy((e) => e.status === "broken"),
  needsReview: countBy((e) => e.status === "needs-review"),
  needsInput: countBy((e) => e.status === "needs-input"),
  overCap: countBy((e) => e.status === "over-cap"),
  todo: countBy((e) => e.status === "todo"),
  outward: countBy((e) => e.outward),
  free: countBy((e) => e.authMode === "free" || e.priceAmount === 0),
};

fs.writeFileSync(CHECKLIST, JSON.stringify(checklist, null, 2));
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));

console.log(`Batch ${BATCH} reconciled. Spend this batch: $${totalCost.toFixed(4)}`);
console.table(summary);
console.log("\nChecklist totals:", JSON.stringify(checklist.totals));
