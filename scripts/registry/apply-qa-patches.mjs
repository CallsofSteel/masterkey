// Apply Registry QA curation patches from curation/qa-pilot/ into the actual curation/<subcat>.json files.
// Usage: node scripts/registry/apply-qa-patches.mjs [--dry-run]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PATCHES_DIR = join(__dir, "curation/qa-pilot");
const CURATION_DIR = join(__dir, "curation");
const DRY = process.argv.includes("--dry-run");

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const patches = readdirSync(PATCHES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(PATCHES_DIR, f), "utf8")));

// Group by subcat
const bySubcat = {};
for (const p of patches) (bySubcat[p.subcat] ??= []).push(p);

let totalApplied = 0;

for (const [subcat, subcatPatches] of Object.entries(bySubcat)) {
  const curationPath = join(CURATION_DIR, `${subcat}.json`);
  let curation;
  try {
    curation = JSON.parse(readFileSync(curationPath, "utf8"));
  } catch {
    console.error(`  ! No curation file for ${subcat} — skip`);
    continue;
  }

  let changed = false;
  for (const patch of subcatPatches) {
    const entry = curation.entries.find((e) => slug(e.name) === patch.serviceId);
    if (!entry) {
      console.warn(`  ! ${patch.serviceId} not found in ${subcat} — skip`);
      continue;
    }

    // Apply drop
    if (patch.drop) {
      entry.status = "hidden";
      if (patch.droppedReason) entry._droppedReason = patch.droppedReason;
      console.log(`  DROP   ${patch.serviceId}`);
      changed = true;
    }

    // Apply usage block (always apply — may overwrite a previous pass)
    if (patch.usage) {
      // Strip the registryFix key before storing (it's metadata for this script, not for curate.mjs)
      const { registryFix: _rf, ...cleanUsage } = patch.usage;
      entry.usage = cleanUsage;
      console.log(`  USAGE  ${patch.serviceId}`);
      changed = true;

      // Apply any registryFix overrides (e.g. method correction for a candidate-indexed backend)
      if (_rf) {
        // Load the candidates file to resolve index → URL for integer backends
        let candidates = null;
        try { candidates = JSON.parse(readFileSync(join(__dir, `candidates/${subcat}.json`), "utf8")).candidates; } catch {}
        let fixApplied = false;
        for (const b of entry.backends || []) {
          if (typeof b === "number") {
            // Only fix if this candidate's URL matches the registryFix target
            const candidateUrl = candidates?.[b]?.url || candidates?.[b]?.key;
            if (candidateUrl && candidateUrl === _rf.backend) {
              entry.resolved ??= {};
              entry.resolved[String(b)] ??= {};
              entry.resolved[String(b)][_rf.field] = _rf.correctValue;
              console.log(`  FIX    ${patch.serviceId} candidate[${b}].${_rf.field} → ${_rf.correctValue}`);
              fixApplied = true;
            }
          } else if (typeof b === "object" && b.url === _rf.backend) {
            b[_rf.field] = _rf.correctValue;
            console.log(`  FIX    ${patch.serviceId} backend.${_rf.field} → ${_rf.correctValue}`);
            fixApplied = true;
          }
        }
        if (!fixApplied) console.warn(`  ! FIX for ${patch.serviceId}: backend ${_rf.backend} not matched`);
      }
    }
  }

  if (changed) {
    if (!DRY) writeFileSync(curationPath, JSON.stringify(curation, null, 2) + "\n");
    console.log(`${DRY ? "[dry] " : ""}Updated ${subcat}.json`);
    totalApplied++;
  }
}

console.log(`\nDone. ${DRY ? "(dry run) " : ""}${totalApplied} curation files updated.`);
