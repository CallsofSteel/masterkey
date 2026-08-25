// Discovery dump: multi-keyword search -> dedupe -> probe -> /api/check -> llms.txt.
// Writes scripts/registry/candidates/<subcat>.json (full) and prints a summary table for curation.
// Usage: node scripts/registry/dump.mjs --subcat=image-generation [--check-cap=60] [--no-cache]
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATEGORIES } from "./queries.mjs";
import * as C from "./core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
if (args.includes("--no-cache")) C.setCache(false);
const SUBCAT = getArg("subcat");
const CHECK_CAP = Number(getArg("check-cap", "60"));

let sub = null, catSlug = null;
for (const cat of CATEGORIES) for (const s of cat.subcategories) if (s.slug === SUBCAT) { sub = s; catSlug = cat.slug; }
if (!sub) { console.error("unknown --subcat:", SUBCAT); process.exit(1); }

const NOW = new Date().toISOString();
const terms = [...new Set(sub.queries.join(" ").toLowerCase().split(/\s+/))].filter((w) => w.length > 2);

async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const seen = new Map();
for (const q of sub.queries) {
  for (const r of await C.search(q)) {
    const u = r.url; if (!u) continue;
    const key = u.replace(/\/+$/, "").toLowerCase();
    if (!seen.has(key)) { r._q = q; seen.set(key, r); }
  }
}
const recs = [...seen.values()];
recs.sort((a, b) => (C.hasPaymentEvidence(b) ? 1 : 0) - (C.hasPaymentEvidence(a) ? 1 : 0));

let checks = 0;
const candidates = await pool(recs, 6, async (r) => {
  const host = C.hostOf(r.url);
  let origin = ""; try { origin = new URL(r.url).origin; } catch { origin = host ? "https://" + host : ""; }
  const path = C.pathOf(r.url);
  const { internal, trivial } = C.classifyPath(path);
  const { hosting, platformName } = C.detectHosting(host);
  const cleaned = C.cleanName(r.title || r.name || host);
  const p = await C.probe(r.url, r.method);
  const payable = p.status === 402;
  const price = C.priceFromAccepts(p.accepts || r.accepts);
  let check = null;
  if (payable && !internal && checks < CHECK_CAP) { checks++; check = await C.checkEndpoint(r.url); }
  const blob = `${r.title || ""} ${r.name || ""} ${r.description || ""} ${path}`.toLowerCase();
  const relevance = terms.reduce((n, t) => n + (blob.includes(t) ? 1 : 0), 0);
  return {
    url: r.url.replace(/\/+$/, ""), key: r.url.replace(/\/+$/, "").toLowerCase(), rawId: r.id, foundVia: r._q,
    title: r.title, name: r.name, description: r.description,
    origin, host, path, method: r.method, authMode: r.authMode, sources: r.sources,
    hosting, platformName, internal, trivial, relevance,
    cleanedName: cleaned.name, nameDirty: cleaned.dirty,
    probeStatus: p.status, probeMethod: p.method, payable,
    price: price ? { amount: price.amount, min: price.min, max: price.max, networks: price.networks, flagged: price.flagged } : null,
    accepts: p.accepts || r.accepts || null,
    check: check ? { summary: check.summary, protocols: check.protocols, instructions: check.instructions, inputSchema: check.inputSchema, outputSchema: check.outputSchema, docs: check.docs } : null,
  };
});

const origins = [...new Set(candidates.map((c) => c.origin).filter(Boolean))];
const llms = {};
await pool(origins, 6, async (o) => { llms[o] = await C.fetchLlms(o); });

const outDir = join(__dir, "candidates");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, SUBCAT + ".json"), JSON.stringify({ subcategory: SUBCAT, category: catSlug, generatedAt: NOW, queries: sub.queries, total: candidates.length, candidates, llms }, null, 2));

function pf(p) {
  if (!p || p.amount == null) return "varies";
  if (p.amount === 0) return "free";
  if (p.min != null && p.max != null && p.max - p.min > 1e-9) return `$${p.min.toFixed(3)}-$${p.max.toFixed(3)}`;
  return `$${p.amount.toFixed(p.amount < 0.01 ? 4 : 3)}`;
}
const payable = candidates.filter((c) => c.payable);
const withLlms = Object.values(llms).filter(Boolean).length;
console.log(`\nSUBCAT ${SUBCAT} (${catSlug}) — ${candidates.length} unique · ${payable.length} payable · ${origins.length} origins · ${checks} checks · llms.txt:${withLlms}`);
console.log("idx pay rel price         host                         flags  name | title");
candidates.forEach((c, i) => {
  const flags = [c.internal ? "INT" : "", c.trivial ? "TRIV" : "", c.hosting === "platform" ? "PLAT" : "", c.nameDirty ? "DIRTY" : "", c.price?.flagged ? "PX?" : ""].filter(Boolean).join("|");
  console.log(`${String(i).padStart(3)} ${c.payable ? "Y" : "-"}  ${String(c.relevance).padStart(2)} ${pf(c.price).padEnd(13)} ${(c.host || "").slice(0, 27).padEnd(27)} ${flags.padEnd(6)} ${(c.cleanedName || "").slice(0, 26)} | ${(c.title || "").slice(0, 28)}`);
});
console.log("\nwritten:", join(outDir, SUBCAT + ".json"));
