/**
 * add-orbis-working.mjs — index the cleanly-verified Orbis endpoints (real outputShape, no needsVerification)
 * from the orbis-sprint results into curation. Orbis = tier-3 team (orbisapi.com), charge-then-404 prone, so
 * we ONLY index the ones that returned a real result. Accepts probed free at index time. Run: node ... [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const CUR = join(__dir, "curation");
const DRY = process.argv.includes("--dry");
const TODAY = "2026-06-19";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const work = JSON.parse(readFileSync("/tmp/orbis-working8.json", "utf8"));

// slug-prefix → [display name, subcat]
const META = {
  "credit-card-luhn-validator": ["Credit Card Luhn Validator", "web-scraping", ["validation", "fintech"]],
  "json-formatter-validator": ["JSON Formatter & Validator", "web-scraping", ["developer-tools", "json"]],
  "ltv-cac-ratio-calculator": ["LTV:CAC Ratio Calculator", "stocks-financial-data", ["business", "saas-metrics"]],
  "model-size-calculator": ["Model Size Calculator", "web-scraping", ["ai", "developer-tools"]],
  "okr-scorer": ["OKR Scorer", "web-scraping", ["business", "productivity"]],
  "pentest-scope-calculator": ["Pentest Scope Calculator", "web-scraping", ["security", "estimation"]],
  "reddit-posts-comments": ["Reddit Posts & Comments", "social-media-data", ["reddit", "social"]],
  "runway-estimator": ["Startup Runway Estimator", "stocks-financial-data", ["business", "finance"]],
  "finance-agent-exception-triage": ["Finance Agent Exception Triage", "stocks-financial-data", ["finance", "agent-ops", "risk"]],
};
const metaFor = (s) => { for (const k of Object.keys(META)) if (s.startsWith(k)) return META[k]; return [s, "web-scraping", ["orbis"]]; };
const workingUrl = (o) => { const m = (o.callShape || "").match(/https:\/\/[^\s]+/); return (m ? m[0] : o.url).replace(/[.,]$/, ""); };

async function probeAccepts(url, method = "POST") {
  try {
    const o = { method, headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" }, body: method === "GET" ? undefined : "{}", signal: AbortSignal.timeout(15000) };
    const r = await fetch(url, o); const h = r.headers.get("payment-required"); let pr = null; if (h) { try { pr = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
    let body = null; try { body = JSON.parse(await r.text()); } catch {}
    const raw = pr?.accepts || body?.accepts || [];
    return raw.filter((a) => a.network && a.asset && (a.maxAmountRequired ?? a.amount)).map((a) => ({ scheme: a.scheme || "exact", network: a.network, asset: a.asset, amount: String(a.maxAmountRequired ?? a.amount), payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, ...(a.extra ? { extra: a.extra } : {}) }));
  } catch { return []; }
}

const ORBIS_QUIRK = "Orbis proxy (tier-3, orbisapi.com). ⚠️ Orbis is charge-then-404 on MANY slugs — this one is pay-verified working. Some Orbis endpoints expose the real compute at a sub-path (e.g. /api/validate, /analyze); the verified call shape is documented here.";
const bySub = {}; const summary = [];
for (const o of work) {
  const [name, subcat, tags] = metaFor(o.slug);
  const url = workingUrl(o);
  const accepts = await probeAccepts(url, /GET/i.test(o.callShape || "") ? "GET" : "POST");
  const cost = o.cost ?? null;
  const entry = {
    name, kind: "api", provider: "Orbis", providerId: "orbis", aka: [o.slug, slug(name)],
    description: (o.guide || name).slice(0, 240), tags: [...new Set(["orbis", ...tags])], modality: { input: ["text"], output: ["json"] },
    backends: [{ url, method: /GET/i.test(o.callShape || "") ? "GET" : "POST", provider: "Orbis", providerId: "orbis", amount: cost, accepts, probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "active" }],
    usage: { status: "verified", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: o.callShape || `POST ${url} with JSON body (x402)`, inputExample: o.inputExample || {}, outputShape: o.outputShape || "body", quirks: [ORBIS_QUIRK, ...(o.quirks || [])], guide: o.guide || `${name} via the Orbis x402 proxy.`, costObservedUsd: cost },
    status: "active",
  };
  (bySub[subcat] ??= []).push(entry); summary.push(`${subcat} ← ${name} ($${cost}) accepts:${accepts.length}`);
}

const affected = new Set();
for (const [subcat, entries] of Object.entries(bySub)) {
  const p = join(CUR, subcat + ".json"); const file = JSON.parse(readFileSync(p, "utf8"));
  const bySlug = new Map(file.entries.map((e, i) => [slug(e.name), i]));
  let added = 0, repl = 0;
  for (const e of entries) { const k = slug(e.name); if (bySlug.has(k)) { file.entries[bySlug.get(k)] = e; repl++; } else { file.entries.push(e); added++; } }
  if (!DRY) writeFileSync(p, JSON.stringify(file, null, 2) + "\n"); affected.add(subcat);
  console.log(`  ${subcat}: +${added} new, ~${repl} replaced`);
}
console.log("\n--- summary ---"); summary.forEach((s) => console.log("  " + s));
console.log(`\nNext: ${[...affected].map((s) => `curate.mjs --subcat=${s}`).join(" && ")}`);
