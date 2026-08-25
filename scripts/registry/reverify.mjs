// Re-verification reader: surface payable / gateway candidates that were DROPPED
// (URL not present in the shipped by-subcat/<slug>.json), grouped by host, so entirely-missed
// origins stand out from extra-operations of already-shipped origins.
// Usage: node scripts/registry/reverify.mjs [--full] <subcat> [<subcat> ...]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/registry/by-subcat");
const CAND = join(__dir, "candidates");
const argv = process.argv.slice(2);
const FULL = argv.includes("--full");
const SUBCATS = argv.filter((a) => !a.startsWith("--"));

const GATEWAYS = ["orbisapi.com", "x402.orth.sh", "orth.sh", "x402helper.xyz", "slinkylayer",
  "imgzen.dev", "xona-agent.com", "blockrun.ai", "stablestudio", "gg402", "paysponge", "civicmerge"];
const isGateway = (h) => GATEWAYS.some((g) => (h || "").includes(g));
const norm = (u) => (u || "").replace(/\/+$/, "").toLowerCase();
const pf = (p) => !p ? "?" : p.amount == null ? "varies" : p.amount === 0 ? "free"
  : (p.min != null && p.max != null && p.max - p.min > 1e-9) ? `$${p.min.toFixed(3)}-$${p.max.toFixed(3)}` : `$${p.amount.toFixed(4)}`;

for (const SUBCAT of SUBCATS) {
  const cf = join(CAND, SUBCAT + ".json");
  if (!existsSync(cf)) { console.log(`\n### ${SUBCAT}: NO candidate file`); continue; }
  const cand = JSON.parse(readFileSync(cf, "utf8"));
  const C = cand.candidates || [];

  const shipped = new Set();          // shipped backend URLs
  const shippedHosts = new Set();     // hosts that have >=1 shipped backend
  const of = join(OUT, SUBCAT + ".json");
  let shippedCount = 0;
  if (existsSync(of)) {
    const svcs = JSON.parse(readFileSync(of, "utf8"));
    shippedCount = svcs.length;
    for (const s of svcs) for (const b of s.backends || []) { shipped.add(norm(b.url)); try { shippedHosts.add(new URL(b.url).host.toLowerCase()); } catch {} }
  }

  const payable = C.filter((c) => c.payable);
  const interest = C.map((c, i) => ({ ...c, i }))
    .filter((c) => (c.payable || isGateway(c.host)) && !shipped.has(norm(c.url)) && !c.internal);

  // group by host
  const byHost = new Map();
  for (const c of interest) { if (!byHost.has(c.host)) byHost.set(c.host, []); byHost.get(c.host).push(c); }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`### ${SUBCAT}  —  ${C.length} cand · ${payable.length} payable · ${shippedCount} shipped svc · ${interest.length} dropped rows across ${byHost.size} hosts`);
  console.log("=".repeat(100));

  // sort: fully-missed hosts first, then by payable count
  const hosts = [...byHost.entries()].sort((a, b) => {
    const am = shippedHosts.has(a[0]) ? 1 : 0, bm = shippedHosts.has(b[0]) ? 1 : 0;
    if (am !== bm) return am - bm;
    return b[1].filter(x => x.payable).length - a[1].filter(x => x.payable).length;
  });

  for (const [host, rows] of hosts) {
    const known = shippedHosts.has(host);
    const npay = rows.filter(r => r.payable).length;
    const tag = known ? "(host already shipped — extra ops)" : isGateway(host) ? "*** GATEWAY ***" : "*** FULLY DROPPED HOST ***";
    console.log(`\n--- ${host}  [${rows.length} rows, ${npay} payable] ${tag}`);
    // representative rows: show all if FULLY DROPPED or gateway; else just summarize
    const show = (known && !FULL) ? rows.slice(0, 2) : rows;
    for (const c of show) {
      console.log(`  [${c.i}] ${c.payable ? "PAY" : "---"} rel=${c.relevance} ${pf(c.price).padEnd(14)} ${c.probeStatus ?? "-"}  ${c.method || "?"} ${c.path}`);
      console.log(`       ${(c.cleanedName || c.name || c.title || "").slice(0,70)}  ::  ${(c.check?.summary || c.description || "").slice(0,110)}`);
    }
    if (known && !FULL && rows.length > 2) console.log(`       … +${rows.length - 2} more ops on this host (already represented)`);
  }
}
