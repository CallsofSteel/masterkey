// verify-no-tangle.mjs — enforce the MASTERKEY_HANDOFF §5.5 anti-tangle rules against the BUILT registry.
// Run after any indexing batch (and in CI). Exits non-zero on violations.
//
//   node scripts/registry/verify-no-tangle.mjs
//
// Checks:
//   1. No two SERVED services share slug(name) within a subcategory  → a collision means a bulk-generate
//      dedup-by-slug silently DROPPED a distinct op, or two ops were mis-merged. (The §5.5 silent-drop trap.)
//   2. Every SERVED, payable (x402) backend has a non-empty backend.payment.accepts (free backends may use a
//      $0/extra.free accept) — never top-level backend.accepts → else "served but unpayable".
//   3. No service NAME embeds a gateway/"(via X)"/"(Gateway)" — the service name is the brand/op, not the host.
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data/registry/by-subcat");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const violations = [];

for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith(".json")) continue;
  const sub = f.replace(/\.json$/, "");
  const services = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  const seen = new Map();
  for (const s of services) {
    if (s.status === "hidden") continue; // hidden = not served; ignore
    // 1. name collision within subcat
    const k = slug(s.name);
    if (seen.has(k)) violations.push(`COLLISION  ${sub}: "${s.name}" (${s.id}) shares slug(name) with ${seen.get(k)} — distinct op dropped or mis-merged`);
    else seen.set(k, s.id);
    // 3. gateway-in-name
    if (/\(via\s|\(gateway\)|\(blockrun\)|\(sponge\)|\(orthogonal\)|\(merit\)|\bvia (BlockRun|Sponge|Orthogonal|Merit|StableStudio)\b/i.test(s.name))
      violations.push(`BAD-NAME   ${sub}: "${s.name}" (${s.id}) embeds a gateway — name must be the brand/op`);
    // 2. served-but-unpayable
    for (const b of s.backends || []) {
      if (b.status === "dead" || b.status === "hidden") continue; // not served
      if (b.accepts && !b.payment) violations.push(`ACCEPTS-LOC ${sub}: ${s.id} backend ${b.url} has top-level .accepts (must be .payment.accepts)`);
      const acc = b.payment?.accepts || [];
      const isX402 = (b.payment?.protocols || []).includes("x402");
      if (isX402 && acc.length === 0) violations.push(`UNPAYABLE  ${sub}: ${s.id} backend ${b.url} x402 but no payment.accepts (served-but-unpayable; free backends need a $0 accept)`);
    }
  }
}

if (violations.length) {
  console.error(`✗ ${violations.length} tangle violation(s):\n` + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log("✓ no tangling: no slug(name) collisions, no gateway-in-name, no served-but-unpayable backends.");
