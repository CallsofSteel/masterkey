// CLI orchestrator: discover → probe → classify → (report | write).
// Usage: node scripts/registry/run.mjs --category=media [--dry-run] [--no-cache] [--cap=8]
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATEGORIES, CATEGORY_BY_SLUG } from "./queries.mjs";
import * as C from "./core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/registry");

const args = process.argv.slice(2);
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const has = (k) => args.includes(`--${k}`);
const DRY = has("dry-run");
const CAP = Number(getArg("cap", DRY ? "8" : "60"));
if (has("no-cache")) C.setCache(false);
const NOW = new Date().toISOString();

function slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function fmtPrice(p) {
  if (!p || p.amount == null) return { display: "Varies", amount: null };
  if (p.amount === 0) return { display: "Free", amount: 0 };
  if (p.min != null && p.max != null && p.max - p.min > 1e-9)
    return { display: `$${p.min.toFixed(3)}–$${p.max.toFixed(3)}`, amount: p.min };
  return { display: `$${p.amount.toFixed(p.amount < 0.01 ? 4 : 3)}`, amount: p.amount };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function processCategory(cat) {
  const seenGlobal = new Set();
  const subReports = [];
  for (const sub of cat.subcategories) {
    // 1. discover
    const recs = [];
    for (const q of sub.queries) {
      for (const r of await C.search(q)) {
        const u = r.url; if (!u) continue;
        const key = u.replace(/\/+$/, "").toLowerCase();
        if (seenGlobal.has(key)) continue;
        seenGlobal.add(key);
        r._key = key; recs.push(r);
      }
    }
    // probe the most promising first (payment evidence), cap per subcat
    recs.sort((a, b) => (C.hasPaymentEvidence(b) ? 1 : 0) - (C.hasPaymentEvidence(a) ? 1 : 0));
    const batch = recs.slice(0, CAP);

    const results = await pool(batch, 5, async (r) => {
      const host = C.hostOf(r.url);
      const { internal, trivial } = C.classifyPath(C.pathOf(r.url));
      const { hosting, platformName } = C.detectHosting(host);
      const evidence = C.hasPaymentEvidence(r);
      const cleaned = C.cleanName(r.title || r.name || host);

      let verdict, status = "active", price = null, reasons = [];
      if (internal) { verdict = "DROP"; reasons.push("internal"); }
      else if (trivial) { verdict = "DISCOVERY"; reasons.push("trivial/meta"); }
      else {
        const p = await C.probe(r.url, r.method);
        if (p.status === 402) {
          verdict = "KEEP"; price = C.priceFromAccepts(p.accepts || r.accepts);
        } else if (p.status >= 200 && p.status < 300) {
          if ((p.method || "GET") !== "GET") { verdict = "REVIEW"; status = "needs-review"; reasons.push(`free non-GET (${p.status})`); }
          else { verdict = "KEEP"; price = { amount: 0, min: 0, max: 0, networks: [] }; }
        } else if (evidence) {
          verdict = "REVIEW"; status = "needs-review";
          reasons.push(`probe blocked (${p.status ?? "err"})`);
          price = C.priceFromAccepts(r.accepts) || { amount: null, networks: [] };
        } else {
          verdict = "DROP"; reasons.push(`no evidence (${p.status ?? "err"})`);
        }
      }
      if ((verdict === "KEEP" || verdict === "REVIEW")) {
        if (hosting === "platform") { if (verdict === "KEEP") { verdict = "REVIEW"; status = "needs-review"; } reasons.push(`platform/${platformName}`); }
        if (cleaned.dirty) { if (verdict === "KEEP") { verdict = "REVIEW"; status = "needs-review"; } reasons.push("name needs cleanup"); }
      }
      return { r, host, hosting, platformName, evidence, cleaned, verdict, status, price, reasons };
    });

    const keep = results.filter((x) => x.verdict === "KEEP");
    const review = results.filter((x) => x.verdict === "REVIEW");
    const drop = results.filter((x) => x.verdict === "DROP");
    const discovery = results.filter((x) => x.verdict === "DISCOVERY");
    subReports.push({ sub, discovered: recs.length, probed: batch.length, keep, review, drop, discovery, results });
  }
  return subReports;
}

function report(cat, subReports) {
  console.log(`\n================ PILOT DRY-RUN: ${cat.name} (${cat.slug}) ================`);
  let tK = 0, tR = 0, tD = 0, tDisc = 0, tFound = 0;
  for (const s of subReports) {
    tK += s.keep.length; tR += s.review.length; tD += s.drop.length; tDisc += s.discovery.length; tFound += s.discovered;
    console.log(`\n■ ${s.sub.slug} — discovered ${s.discovered}, probed ${s.probed}  →  KEEP ${s.keep.length} · REVIEW ${s.review.length} · DROP ${s.drop.length} · DISC ${s.discovery.length}`);
    for (const x of [...s.keep, ...s.review]) {
      const fp = fmtPrice(x.price);
      const nets = x.price?.networks?.length ? x.price.networks.join(",") : "";
      const flag = x.verdict === "REVIEW" ? `  [needs-review: ${x.reasons.join("; ")}]` : "";
      console.log(`   ${x.verdict === "KEEP" ? "✓" : "~"} ${x.cleaned.name.slice(0, 34).padEnd(34)} ${fp.display.padEnd(13)} ${nets.padEnd(16)} ${x.hosting}${flag}`);
    }
    if (s.drop.length) {
      const reasons = {};
      for (const d of s.drop) { const r = d.reasons[0] || "?"; reasons[r] = (reasons[r] || 0) + 1; }
      console.log(`     drop reasons: ${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    }
  }
  console.log(`\n---------------- SUMMARY ${cat.slug} ----------------`);
  console.log(`  discovered(unique): ${tFound}   probed cap: ${CAP}/subcat`);
  console.log(`  KEEP ${tK} · NEEDS-REVIEW ${tR} · DROP ${tD} · DISCOVERY-ONLY ${tDisc}`);
  console.log(DRY ? `\n  (dry-run — nothing written)\n` : "");
}

(async () => {
  const cats = has("all") ? CATEGORIES : [CATEGORY_BY_SLUG[getArg("category", "media")]].filter(Boolean);
  if (!cats.length) { console.error("Unknown --category"); process.exit(1); }
  for (const cat of cats) {
    const subReports = await processCategory(cat);
    report(cat, subReports);
    // (write path implemented for the loop; dry-run skips)
  }
})();
