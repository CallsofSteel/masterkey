// Whole-registry QA: MPP leaks, gateway-named entries, dup services across subcats,
// empty-backend entries, schema sanity. Read-only.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const BY = join(__dir, "../../data/registry/by-subcat");

const GATEWAY_NAMES = ["orbis", "orbisapi", "orthogonal", "x402helper", "x402 helper", "httpay", "blockrun", "gg402", "slinkylayer", "xona", "stablestudio", "paysponge", "civicmerge", "gateway"];
const isMpp = (b) => /paywithlocus|\.mpp\.|temponaut\.xyz/i.test(b.url || "") ||
  ((b.payment?.protocols || []).includes("mpp") && !(b.payment?.protocols || []).includes("x402"));

let totalSvc = 0, totalBk = 0, problems = 0;
const byId = new Map();        // service id -> [subcats]
const perCat = {};

for (const f of readdirSync(BY).filter((f) => f.endsWith(".json"))) {
  let svcs;
  try { svcs = JSON.parse(readFileSync(join(BY, f), "utf8")); }
  catch (e) { console.log(`!! ${f}: INVALID JSON ${e.message}`); problems++; continue; }
  for (const s of svcs) {
    totalSvc++;
    (perCat[s.category] ??= 0); perCat[s.category]++;
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s.subcategory);
    // entry named after a gateway?
    const nm = (s.name || "").toLowerCase();
    if (GATEWAY_NAMES.some((g) => nm === g)) { console.log(`!! [${f}] entry named after gateway: "${s.name}"`); problems++; }
    // backends
    const bks = s.backends || [];
    if (!bks.length && !(s.operations || []).length) { console.log(`!! [${f}] "${s.name}" has ZERO backends`); problems++; }
    for (const b of bks) {
      totalBk++;
      if (isMpp(b)) { console.log(`!! [${f}] "${s.name}" has MPP backend: ${b.url}`); problems++; }
      if (!b.url) { console.log(`!! [${f}] "${s.name}" backend missing url`); problems++; }
      if (b.price?.amount == null && b.price?.display !== "Varies") { /* ok: varies */ }
    }
    // required fields
    for (const k of ["id", "name", "provider", "category", "subcategory", "pricing"]) {
      if (s[k] == null) { console.log(`!! [${f}] "${s.name}" missing field: ${k}`); problems++; }
    }
  }
}

// duplicate service ids across subcats
for (const [id, subs] of byId) {
  if (subs.length > 1) { console.log(`!! duplicate service id "${id}" in: ${subs.join(", ")}`); problems++; }
}

console.log(`\n=== QA SUMMARY ===`);
console.log(`services: ${totalSvc} · backends: ${totalBk} · problems: ${problems}`);
console.log("per-category counts:");
for (const [c, n] of Object.entries(perCat).sort()) console.log(`  ${c.padEnd(26)} ${n}`);
console.log(problems === 0 ? "\nALL CLEAN ✅" : `\n${problems} PROBLEM(S) ⚠️`);
