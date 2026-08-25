/**
 * qa-make-patches.mjs — auto-generate curation patches from a batch's results (scales to any size).
 *
 * Groups a batch's per-endpoint results by serviceId and writes curation/qa-batch-<N>/<serviceId>.json
 * patches that apply-qa.mjs folds into the live registry. Per service it decides:
 *   • any backend verified           → statusOverride:"active", usage = best verified backend's doc,
 *                                       registryFixes[] = REAL per-backend price (from the spend log) +
 *                                       corrected method (parsed from the verified callShape).
 *   • all backends broken            → drop:true (status hidden) + droppedReason (real cost lost, hints).
 *   • only needs-input / no verified → statusOverride:"needs-review" (revisit; keep usage for context).
 *
 * Real cost ("beyond-surface") is taken from data/registry/qa-spend-log.jsonl (authoritative settled
 * amount) keyed by URL, falling back to the agent's costObservedUsd. The generated patches are DRAFTS —
 * review/adjust nuanced ones (salvage paths, partial-failures) before apply.
 *
 * Usage: node scripts/registry/qa-make-patches.mjs --batch=N
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const BATCH = String((process.argv.find((a) => a.startsWith("--batch=")) || "--batch=1").split("=")[1]);

const results = JSON.parse(fs.readFileSync(path.join(ROOT, `data/registry/qa-batch-${BATCH}-results.json`), "utf8"));
const checklist = JSON.parse(fs.readFileSync(path.join(ROOT, "data/registry/qa-checklist.json"), "utf8"));
const rowByKey = new Map(checklist.endpoints.map((e) => [e.key, e]));

// real settled cost from the spend log. Key by LABEL (= the unique endpoint key the workflow passes to
// qa-pay) for an authoritative per-endpoint price — this avoids the URL collision when many models share
// one gateway URL (BlockRun) AND avoids unreliable agent self-report fields. Keep a URL map as fallback.
const spendByLabel = {};
const spendByUrl = {};
const logPath = path.join(ROOT, "data/registry/qa-spend-log.jsonl");
if (fs.existsSync(logPath)) {
  for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.costUsd == null) continue;
      if (e.label) spendByLabel[e.label] = e.costUsd; // last (most recent) settled amount for this endpoint
      if (e.url) spendByUrl[e.url] = e.costUsd;
    } catch {}
  }
}

const OUT = path.join(ROOT, "scripts/registry/curation", `qa-batch-${BATCH}`);
fs.mkdirSync(OUT, { recursive: true });

const VERIFIED = new Set(["verified", "verified-with-quirks", "free-ok"]);
const methodOf = (callShape) => (callShape || "").match(/\b(GET|POST|PUT|DELETE|PATCH)\b/)?.[0];

// group results by serviceId
const groups = {};
for (const r of results) {
  const a = r.phaseA || {};
  (groups[a.serviceId] ??= []).push(r);
}

let written = 0;
for (const [serviceId, group] of Object.entries(groups)) {
  const subcat = rowByKey.get(group[0].phaseA.key)?.subcategory || null;
  const phaseAs = group.map((r) => r.phaseA);
  const anyVerified = phaseAs.some((a) => VERIFIED.has(a.classification));
  const anyNeedsInput = phaseAs.some((a) => a.classification === "needs-input" || a.classification === "over-cap");
  const allBroken = phaseAs.every((a) => a.classification === "broken");

  // pick best backend for the usage block: prefer verified-with-quirks (richest), then verified, then any
  const best =
    phaseAs.find((a) => a.classification === "verified-with-quirks") ||
    phaseAs.find((a) => VERIFIED.has(a.classification)) ||
    phaseAs[0];

  // Terminal (truly dead → DROP) vs transient (might recover → needs-review), decided automatically so
  // batches need no hand-review. Terminal = dead route (404/410) or a paid call that then failed with a
  // client error (charge-then-fail money-trap). Transient = host down / 5xx / timeouts / rate-limit.
  const isTerminal = (a) => {
    const s = Number(a.httpStatus);
    if (s === 404 || s === 410) return true;
    if (a.paid === true && [400, 401, 403, 409, 422].includes(s)) return true;
    return false;
  };
  let drop = false;
  let statusOverride = null;
  if (anyVerified) statusOverride = "active";
  else if (allBroken) {
    if (phaseAs.some(isTerminal)) drop = true; // at least one confirmed-dead backend → drop the service
    else statusOverride = "needs-review";       // all failures look transient → revisit, don't drop
  } else statusOverride = "needs-review";        // needs-input / mixed unresolved

  // per-backend real price + method fixes. PRICE SOURCE = the agent's per-call costObservedUsd (accurate
  // per endpoint), NOT spendByUrl — many models share ONE gateway URL (e.g. BlockRun serves every model
  // at /api/v1/chat/completions, distinguished by modelParam), so a URL-keyed spend lookup collides.
  // spendByUrl is only a fallback when the per-call cost is missing.
  const registryFixes = [];
  for (const a of phaseAs) {
    const row = rowByKey.get(a.key);
    const url = row?.url;
    if (!url) continue;
    // price source priority: spend-log-by-label (authoritative per-endpoint) → agent costObservedUsd → spend-log-by-url
    const perCall = Number(a.costObservedUsd);
    const realCost =
      spendByLabel[a.key] != null ? spendByLabel[a.key] : (Number.isFinite(perCall) && perCall > 0 ? perCall : spendByUrl[url]);
    const m = methodOf(a.callShape);
    const fix = { backend: url };
    if (m) fix.method = m;
    if (VERIFIED.has(a.classification) && realCost != null) fix.amountUsd = realCost;
    if (fix.method || fix.amountUsd != null) registryFixes.push(fix);
  }

  const usage = {
    status: best.usageStatus || (anyVerified ? "verified" : drop ? "broken" : "untested"),
    verifiedAt: "2026-06-08",
    resultPull: best.resultPull || "sync",
    auth: best.auth || "none",
    callShape: best.callShape || "",
    inputExample: best.inputExample || {},
    outputShape: best.outputShape || "",
    quirks: best.quirks || [],
    needs: best.needs || [],
    needsApproval: !!best.needsApproval,
    guide: best.guide || "",
    costObservedUsd: best.costObservedUsd ?? 0,
  };
  if (drop) usage.droppedReason = phaseAs.map((a) => `${a.key}: ${(a.quirks || [])[0] || a.classification}`).join(" | ");

  const patch = {
    serviceId,
    subcat,
    batchId: `batch-${BATCH}`,
    action: drop ? "drop" : "add-usage",
    drop,
    statusOverride,
    registryFixes,
    usage,
    droppedReason: drop ? usage.droppedReason : null,
    _backends: group.map((r) => ({ key: r.phaseA.key, classification: r.phaseA.classification, phaseB: r.phaseB?.verdict, realCostUsd: spendByUrl[rowByKey.get(r.phaseA.key)?.url] ?? null })),
  };

  fs.writeFileSync(path.join(OUT, `${serviceId}.json`), JSON.stringify(patch, null, 2) + "\n");
  written++;
  console.log(`  ${drop ? "DROP " : (statusOverride || "").padEnd(11)} ${serviceId.padEnd(34)} (${group.length}bk, ${registryFixes.length} fix)`);
}
console.log(`\n${written} patch(es) written to curation/qa-batch-${BATCH}/. Review nuanced ones (salvage paths), then: node scripts/registry/apply-qa.mjs --batch=${BATCH}`);
