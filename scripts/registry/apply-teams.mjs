// Backfill operating-team tags across the WHOLE registry. Stamps `team` on every backend + operation
// by host (scripts/registry/teams.mjs) in all by-subcat/*.json, then writes the distinct `teams[]` onto
// each index.json EntrySummary so the catalog + MCP can filter/rank by team without fetching detail.
//
// curate.mjs already stamps teams, but it only rewrites ONE subcat per run, so this sweep applies the
// tags to the already-built files in one shot. Idempotent — safe to re-run after adding a team rule.
// Usage: node scripts/registry/apply-teams.mjs [--dry-run]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stampTeams } from "./teams.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/registry");
const BYSUB = join(OUT, "by-subcat");
const DRY = process.argv.includes("--dry-run");

const byId = new Map(); // serviceId -> distinct teams[]
const tally = {}; // team -> backend/op count
let files = 0, taggedEndpoints = 0;

for (const f of readdirSync(BYSUB).filter((f) => f.endsWith(".json"))) {
  const p = join(BYSUB, f);
  const arr = JSON.parse(readFileSync(p, "utf8"));
  for (const s of arr) {
    const teams = stampTeams(s);
    if (teams.length) {
      const prev = byId.get(s.id) || [];
      byId.set(s.id, [...new Set([...prev, ...teams])].sort());
    }
    for (const ep of [...(s.backends || []), ...(s.operations || [])])
      if (ep.team) { taggedEndpoints++; tally[ep.team] = (tally[ep.team] || 0) + 1; }
  }
  if (!DRY) writeFileSync(p, JSON.stringify(arr, null, 2));
  files++;
}

// Write distinct teams[] onto each index.json EntrySummary (keyed by service id); drop stale ones.
const idxPath = join(OUT, "index.json");
const idx = JSON.parse(readFileSync(idxPath, "utf8"));
let taggedEntries = 0;
for (const e of idx.entries) {
  const teams = byId.get(e.id);
  if (teams && teams.length) { e.teams = teams; taggedEntries++; }
  else delete e.teams;
}
if (!DRY) writeFileSync(idxPath, JSON.stringify(idx, null, 2));

console.log(`${DRY ? "[dry-run] " : ""}teams backfill: ${files} subcat files · ${taggedEndpoints} endpoints tagged · ${taggedEntries} index entries tagged`);
console.log("  by team:", tally);
