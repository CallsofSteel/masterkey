#!/usr/bin/env node
/**
 * verify-drift.mjs — guardrail against curation↔by-subcat DRIFT.
 *
 * The shipped registry (data/registry/by-subcat/*.json + index.json) is a PURE PROJECTION of
 * scripts/registry/curation/*.json (via curate.mjs, id = slug(name)). Editing by-subcat/index DIRECTLY
 * (a "surgical" edit) without also updating curation creates drift: the next `curate.mjs` silently reverts
 * the surgical edit. This exact bug once hid dead Apollo endpoints in by-subcat while curation still said
 * `active` — a curate would have un-hidden them.
 *
 * This check compares, per subcat, the STATUS of every service that exists in BOTH curation and the shipped
 * by-subcat (keyed on id = slug(name)) — the exact surgical-edit bug class. It does NOT flag shipped-only
 * ids (legitimately merged from first-party.json at curate time) NOR curation-only ids (curate legitimately
 * PRUNES entries with no payable x402 backend), so it has zero false positives. Exit non-zero on mismatch.
 *
 * Usage: node scripts/registry/verify-drift.mjs
 * Wire into CI / `npm run registry:build` so a surgical edit can't ship without updating curation.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CUR = join(__dir, "curation");
const BYSUB = join(__dir, "../../data/registry/by-subcat");
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let problems = 0;
for (const f of readdirSync(BYSUB).filter((x) => x.endsWith(".json"))) {
  const curPath = join(CUR, f);
  if (!existsSync(curPath)) continue; // no curation source (e.g. dynamic subcats) → not curate-owned
  const shipped = JSON.parse(readFileSync(join(BYSUB, f), "utf8"));
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  const sub = f.replace(".json", "");

  const expected = new Map((cur.entries || []).map((e) => [slug(e.name), e.status || "active"]));
  const shippedById = new Map(shipped.map((s) => [s.id, s.status || "active"]));

  // status drift on entries present in both (the surgical-edit bug class)
  for (const [id, shippedStatus] of shippedById) {
    if (expected.has(id) && expected.get(id) !== shippedStatus) {
      console.error(`  ✗ ${sub}: "${id}" status shipped=${shippedStatus} but curation=${expected.get(id)} — a by-subcat edit bypassed curation (re-run curate, or move the change into curation).`);
      problems++;
    }
  }
}

if (problems) {
  console.error(`\n✗ verify-drift: ${problems} curation↔by-subcat mismatch(es). Never hand-edit data/registry/by-subcat/* or index.json — author in curation/<subcat>.json then run curate.mjs.`);
  process.exit(1);
}
console.log("✓ verify-drift: every shipped by-subcat service matches its curation projection (id + status).");
