/**
 * qa-finish-batch.mjs — one-shot batch finisher for the autonomous run.
 *
 * Chains the entire post-workflow pipeline so a batch is closed out in a single terse command (no
 * per-batch hand-review, minimal driver context): extract results from the workflow's task-output file
 * → reconcile → auto-generate curation patches → verifier briefs → apply to curation → rebuild the
 * affected by-subcat slugs → refresh the checklist. Prints only a compact digest.
 *
 * Usage: node scripts/registry/qa-finish-batch.mjs --batch=N --task-output=/abs/path/to/<taskid>.output
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
const BATCH = arg("batch");
const TASK_OUTPUT = arg("task-output");
if (!BATCH || !TASK_OUTPUT) {
  console.error("usage: qa-finish-batch.mjs --batch=N --task-output=<path>");
  process.exit(2);
}

// Safe runner: execFile (no shell) → no command injection. Args passed as an array.
const node = (scriptArgs) => execFileSync("node", scriptArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 1) extract structured results from the workflow task-output file
const raw = fs.readFileSync(TASK_OUTPUT, "utf8");
let parsed;
try { parsed = JSON.parse(raw); } catch { parsed = null; }
let res = parsed && parsed.result;
if (typeof res === "string") { try { res = JSON.parse(res); } catch {} }
const results = (res && res.results) || (parsed && parsed.results) || [];
if (!results.length) {
  console.error(`[finish] no results found in ${TASK_OUTPUT} — aborting (nothing reconciled).`);
  process.exit(1);
}
fs.writeFileSync(path.join(ROOT, `data/registry/qa-batch-${BATCH}-results.json`), JSON.stringify(results, null, 2));

// 2) reconcile → patches → briefs → apply
node(["scripts/registry/qa-reconcile.mjs", `--batch=${BATCH}`]);
node(["scripts/registry/qa-make-patches.mjs", `--batch=${BATCH}`]);
node(["scripts/registry/qa-briefs.mjs", `--batch=${BATCH}`]);
node(["scripts/registry/apply-qa.mjs", `--batch=${BATCH}`]);

// 3) rebuild only the affected subcats
const checklist = JSON.parse(fs.readFileSync(path.join(ROOT, "data/registry/qa-checklist.json"), "utf8"));
const subByKey = new Map(checklist.endpoints.map((e) => [e.key, e.subcategory]));
const subcats = [...new Set(results.map((r) => subByKey.get(r.phaseA?.key)).filter(Boolean))];
for (const s of subcats) node(["scripts/registry/curate.mjs", `--subcat=${s}`]);

// 4) refresh the checklist
node(["scripts/registry/build-checklist.mjs"]);

// 5) digest
const after = JSON.parse(fs.readFileSync(path.join(ROOT, "data/registry/qa-checklist.json"), "utf8"));
const tally = {};
for (const r of results) { const c = r.phaseA?.classification || "?"; tally[c] = (tally[c] || 0) + 1; }

const keys = new Set(results.map((r) => r.phaseA?.key).filter(Boolean));
let batchLogged = 0;
const logPath = path.join(ROOT, "data/registry/qa-spend-log.jsonl");
if (fs.existsSync(logPath)) {
  for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)) {
    try { const e = JSON.parse(line); if (keys.has(e.label)) batchLogged += e.costUsd || 0; } catch {}
  }
}

const t = after.totals;
console.log(`BATCH ${BATCH} DONE`);
console.log(`  classes: ${JSON.stringify(tally)}`);
console.log(`  subcats rebuilt: ${subcats.join(", ")}`);
console.log(`  batch spend (logged): $${batchLogged.toFixed(4)}`);
console.log(`  TOTALS: verified=${t.verified} broken=${t.broken} needs-review=${t.needsReview} needs-input=${t.needsInput} todo=${t.todo} / ${t.endpoints}`);
console.log(`  REMAINING_TODO=${t.todo}`);
