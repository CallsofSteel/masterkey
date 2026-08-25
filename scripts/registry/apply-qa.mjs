/**
 * apply-qa.mjs — fold ALL QA findings (pilot + every batch) into the durable curation files, so the
 * next `curate.mjs` rebuild makes data/registry/by-subcat/*.json perfectly reflect tested reality.
 *
 * Reads every curation/qa-* patch dir (qa-pilot, qa-batch-1, qa-batch-2, …) and, for each patch,
 * merges into curation/<subcat>.json the things you only learn by PAYING ("beyond surface"):
 *   • entry.usage         ← the rich how-to-use doc (guide, quirks, callShape, inputExample, outputShape,
 *                            resultPull incl. pay-then-SIWX flows, costObservedUsd)
 *   • entry.status        ← "hidden" when drop:true (broken/charges-then-fails); else statusOverride
 *   • entry.description   ← descriptionOverride (when the surface description was wrong/thin)
 *   • entry.resolved[idx] ← per-backend REAL price (amountUsd) + corrected method, keyed by candidate
 *                            index (resolved from candidates/<subcat>.json by URL). curate recomputes
 *                            pricing.headline from these real amounts.
 * Accepts both registryFixes:[{backend,method?,amountUsd?}] and the legacy single registryFix:{...}.
 *
 * Idempotent — re-running re-applies the same patches to the same result. After running, rebuild:
 *   node scripts/registry/curate.mjs --subcat=<each affected subcat>
 *
 * Usage: node scripts/registry/apply-qa.mjs [--dry-run] [--batch=1]   (--batch limits to qa-batch-<N>)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CURATION_DIR = join(__dir, "curation");
const CANDIDATES_DIR = join(__dir, "candidates");
const DRY = process.argv.includes("--dry-run");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const onlyBatch = batchArg ? `qa-batch-${batchArg.split("=")[1]}` : null;

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// discover patch dirs: qa-pilot + qa-batch-N (or just the requested one)
const patchDirs = readdirSync(CURATION_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^qa-(pilot|batch-\d+)$/.test(d.name))
  .map((d) => d.name)
  .filter((name) => !onlyBatch || name === onlyBatch)
  .sort();

console.log(`Patch dirs: ${patchDirs.join(", ") || "(none)"}`);

// gather patches, grouped by subcat
const bySubcat = {};
for (const dir of patchDirs) {
  for (const f of readdirSync(join(CURATION_DIR, dir)).filter((f) => f.endsWith(".json"))) {
    const p = JSON.parse(readFileSync(join(CURATION_DIR, dir, f), "utf8"));
    p._dir = dir;
    (bySubcat[p.subcat] ??= []).push(p);
  }
}

const candCache = {};
function candidatesFor(subcat) {
  if (!(subcat in candCache)) {
    const p = join(CANDIDATES_DIR, `${subcat}.json`);
    candCache[subcat] = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).candidates : null;
  }
  return candCache[subcat];
}

function applyBackendFix(entry, candidates, fix) {
  const targetUrl = fix.backend;
  const method = fix.method ?? fix.correctValue; // legacy registryFix used field/correctValue
  const amount = fix.amountUsd;
  let applied = false;
  for (const b of entry.backends || []) {
    if (typeof b === "number") {
      const url = candidates?.[b]?.url || candidates?.[b]?.key;
      if (url && url === targetUrl) {
        entry.resolved ??= {};
        entry.resolved[String(b)] ??= {};
        if (method) entry.resolved[String(b)].method = method;
        if (amount != null) entry.resolved[String(b)].amount = amount;
        applied = true;
      }
    } else if (typeof b === "object" && b.url === targetUrl) {
      if (method) b.method = method;
      if (amount != null) { b.amount = amount; }
      applied = true;
    }
  }
  return applied;
}

let filesChanged = 0;
for (const [subcat, patches] of Object.entries(bySubcat)) {
  const curationPath = join(CURATION_DIR, `${subcat}.json`);
  if (!existsSync(curationPath)) { console.error(`  ! no curation/${subcat}.json — skip`); continue; }
  const curation = JSON.parse(readFileSync(curationPath, "utf8"));
  const candidates = candidatesFor(subcat);
  let changed = false;

  for (const patch of patches) {
    const entry = curation.entries.find((e) => slug(e.name) === patch.serviceId);
    if (!entry) { console.warn(`  ! ${patch.serviceId} not in ${subcat} — skip`); continue; }

    if (patch.usage) {
      const { registryFix: _x, registryFixes: _y, ...clean } = patch.usage; // strip any stray helper keys
      entry.usage = clean;
    }
    if (patch.drop) {
      entry.status = "hidden";
      if (patch.droppedReason) entry._droppedReason = patch.droppedReason;
    } else if (patch.statusOverride) {
      entry.status = patch.statusOverride;
    }
    if (patch.descriptionOverride) entry.description = patch.descriptionOverride;

    const fixes = patch.registryFixes || (patch.registryFix ? [patch.registryFix] : []);
    for (const fix of fixes) {
      const ok = applyBackendFix(entry, candidates, fix);
      if (!ok) console.warn(`  ! ${patch.serviceId}: backend ${fix.backend} not matched`);
    }

    console.log(`  ${patch.drop ? "DROP " : "APPLY"} ${patch.serviceId}  [${patch._dir}]${fixes.length ? ` (+${fixes.length} backend fix)` : ""}`);
    changed = true;
  }

  if (changed) {
    if (!DRY) writeFileSync(curationPath, JSON.stringify(curation, null, 2) + "\n");
    filesChanged++;
  }
}

console.log(`\n${DRY ? "[dry] " : ""}Updated ${filesChanged} curation file(s). Now rebuild: node scripts/registry/curate.mjs --subcat=<subcat>`);
