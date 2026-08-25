#!/usr/bin/env node
// Masterkey — guardrail: every serviceId pinned by a curated bundle must resolve in the registry.
//
// Run: node scripts/registry/verify-bundle-pins.mjs   (exit 1 on any dead pin)
//
// WHY THIS EXISTS. A dead pin does NOT fail loudly — it fails as a *spurious approval prompt*, which is
// far harder to diagnose. `classifyApproval` is default-deny: an unresolvable serviceId returns
// `{needsApproval: true, reason: "unknown_service", action: "publish"}`, so the run pauses and asks the
// human to approve "publishing"… a Google search. The bundle then sits unattended forever.
//
// Found live on 2026-07-26: `data/bundles/research.json` still pinned `serper`, which the 2026-06-10
// remediation had un-bundled into 11 per-op services (`serper-web-search`, `serper-news`, …). Same for
// `apollo-io` -> `apollo-people-search` in recruit.json. Both silently broke their bundles.
//
// Registry entries legitimately come and go (providers rename/remove endpoints), so this must run after
// any registry curation — alongside verify-drift.mjs and verify-no-tangle.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BUNDLES_DIR = "data/bundles";
const INDEX = "data/registry/index.json";

const idx = JSON.parse(readFileSync(INDEX, "utf8"));
const known = new Set((idx.entries ?? idx.services ?? []).map((e) => e.id).filter(Boolean));
if (!known.size) {
  console.error(`verify-bundle-pins: no entries read from ${INDEX} — refusing to pass vacuously.`);
  process.exit(1);
}

/** Every serviceId a bundle pins, across the legacy linear `steps[]` and the newer `graph.nodes[]`. */
function pinsOf(bundle) {
  const out = [];
  for (const s of bundle.steps ?? []) if (s.serviceId) out.push(s.serviceId);
  for (const n of bundle.graph?.nodes ?? []) {
    const sid = n.data?.serviceId ?? n.serviceId;
    if (sid) out.push(sid);
  }
  return out;
}

let dead = 0;
let checked = 0;
for (const file of readdirSync(BUNDLES_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const bundle = JSON.parse(readFileSync(join(BUNDLES_DIR, file), "utf8"));
  const pins = pinsOf(bundle);
  checked += pins.length;
  // Apify actors resolve dynamically via src/lib/apify.ts, never from the registry index.
  const missing = pins.filter((p) => !known.has(p) && !p.startsWith("apify:"));
  if (missing.length) {
    dead += missing.length;
    console.error(`✗ ${file}: dead pin(s) -> ${missing.join(", ")}`);
  } else {
    console.log(`✓ ${file} (${pins.length} pins)`);
  }
}

console.log(`\n${checked} pins checked across curated bundles; ${dead} dead.`);
if (dead) {
  console.error(
    "\nA dead pin makes the bundle pause for a bogus 'approve publishing' prompt (default-deny on an\n" +
      "unresolvable service), not throw. Repoint each to a live serviceId — check the registry index for\n" +
      "the per-op replacement (e.g. serper -> serper-web-search, apollo-io -> apollo-people-search).",
  );
  process.exit(1);
}
