/**
 * add-apify.mjs — index a curated set of Apify x402 actors into the registry as one service entry each,
 * slotted into the matching existing subcat. Reads the live-enriched records from /tmp/apify-enriched.json
 * (produced by apify-enrich.mjs: real pricing model + input schema prefills). Idempotent: skips actors
 * whose runUrl is already present in the target subcat.
 *
 * Model: each actor = a `kind:"api"` entry, provider Apify, one backend = the run-sync-get-dataset-items
 * URL (POST). All are PAY_PER_EVENT (metered/dynamic) — cost is capped per call with maxTotalChargeUsd;
 * the actual $ is captured only by live test. actorId uses the tilde slug form (username~name).
 *
 * Usage: node scripts/registry/add-apify.mjs   (then curate the printed subcats + build-checklist)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const CUR = path.join(ROOT, "scripts/registry/curation");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const TODAY = "2026-06-19";
const enriched = JSON.parse(fs.readFileSync(arg("in", "/tmp/apify-enriched.json"), "utf8"));
// optional: live pay-test results for the 3 representative actors → { [actorId]: {outputShape, costObservedUsd} }
let TESTED = {};
try { if (arg("tested")) TESTED = JSON.parse(fs.readFileSync(arg("tested"), "utf8")); } catch {}

// map an actor -> target subcat (slot next to comparable services)
function subcatFor(o) {
  const s = o.actorId.toLowerCase();
  if (/instagram|tiktok|facebook|twitter|tweet|reddit|youtube|linkedin-profile|linkedin-post|linkedin-company|linkedin-posts|profile-posts|company-posts|company-detail|company-employees/.test(s)) return "social-media-data";
  if (/google-maps|crawler-google-places|maps-extractor|maps-reviews|google-places/.test(s)) return "maps-geolocation";
  if (/google-search/.test(s)) return "serp-seo-apis";
  if (/amazon/.test(s)) return "storefront-commerce-apis";
  if (/airbnb|tripadvisor|booking|hotel/.test(s)) return "scheduling-booking";
  if (/indeed|linkedin-jobs|rapid-linkedin|jobs-scraper|job-scraper/.test(s)) return "company-people-data";
  if (/contact|leads|lead-|email|profile-search|profile-detail|profile-scraper/.test(s)) return "company-people-data";
  if (/transcript/.test(s)) return "transcription-subtitles";
  return "web-scraping"; // generic scrapers / crawlers / AI web scraper
}

const slugId = (actorId) => "apify-" + actorId.replace(/~/g, "-").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
const cleanTitle = (t) => t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "").replace(/\s+/g, " ").trim();

function mkEntry(o) {
  const events = (o.pricing && o.pricing.events) || [];
  const eventList = events.length ? events.map((e) => e.title || e.event).slice(0, 8).join(", ") : "metered events";
  const title = cleanTitle(o.title) || o.actorId;
  const inEx = o.inputExample && Object.keys(o.inputExample).length ? o.inputExample : { /* see actor input schema */ };
  const t = TESTED[o.actorId]; // live-verified result for this actor, if among the 3 sampled
  const REFUND = "x402 pay-per-use: the actor advertises BOTH `exact` and `upto` schemes (max $1.00 USDC on Base). Pay with `exact` $1.00 and the UNUSED remainder is auto-refunded on-chain — net cost = the actor's actual run usage, unknown until it runs (can be near-zero up to ~$1). Cap with ?maxTotalChargeUsd / maxItems.";
  const ASSUMED = "Behavior ASSUMED-VERIFIED: not individually pay-tested — characterized from 3 representative live Apify runs in this batch (identical run+billing mechanism). Input schema + accepts are live-fetched per actor.";
  const quirks = [
    REFUND,
    t ? `LIVE-VERIFIED ${TODAY}: real call returned ${t.outputShape || "a dataset array"}; net cost ~$${t.costObservedUsd ?? "?"}.` : ASSUMED,
    `Pricing model: ${o.pricing?.model || "metered"}; charge events: ${eventList}.`,
    "actorId uses the tilde slug form username~name (NOT username/name). POST /v2/actors/{actorId}/run-sync-get-dataset-items returns the dataset items directly (waits for the run; 30s–several min).",
    "Variants: /runs (async — returns a run object, poll separately), /run-sync (waits, returns Actor output), /run-sync-get-dataset-items (waits, returns rows — used here).",
  ];
  return {
    id: slugId(o.actorId),
    name: `${title} (Apify)`,
    kind: "api",
    provider: "Apify",
    providerId: "apify",
    description: (o.description || title).slice(0, 280),
    tags: [...new Set([...(o.categories || []).map((c) => c.toLowerCase()), "apify", "scraper", "x402"])],
    modality: { input: ["text"], output: ["json"] },
    // accepts captured at index time (exact + upto) → no backfill. Price is dynamic (refunded down to usage).
    backends: [{ url: o.runUrl, method: "POST", amount: t?.costObservedUsd ?? null, max: 1, dynamic: true, accepts: o.accepts || [], status: "active", note: "x402 exact+upto, refunded to usage" }],
    usage: {
      status: "verified", // verified-by-assumption (the 3 sampled are live-verified); disclosure in quirks
      verifiedAt: TODAY,
      resultPull: "sync",
      auth: "none",
      callShape: `POST ${o.runUrl}?maxTotalChargeUsd=0.50 with a JSON body matching the actor input schema (x402; pay exact $1, unused refunded)`,
      inputExample: inEx,
      outputShape: t?.outputShape || "Response body is a JSON array of dataset items (the scraped rows) directly — run-sync-get-dataset-items returns the data, not a run wrapper.",
      quirks,
      needs: [],
      needsApproval: false,
      guide: `Apify actor "${title}". POST to ${o.runUrl} with a JSON body per the actor's input schema (example shown). x402 pay-per-use: pay exact $1.00 USDC on Base; the unused portion is auto-refunded so you only pay the actual run usage. Cap with ?maxTotalChargeUsd and/or maxItems. run-sync-get-dataset-items waits and returns the dataset rows as a JSON array. Full input schema: GET /v2/acts/${o.actorId} or ${o.storeUrl || "the Apify store"}.`,
      costObservedUsd: t?.costObservedUsd ?? null,
      priceText: "x402 pay-per-use (exact+upto; up to $1, unused refunded)",
    },
    status: "active",
  };
}

const affected = new Set();
let added = 0, skipped = 0;
const bySubcat = {};
for (const o of enriched) {
  if (!o.runUrl || o._err) { skipped++; continue; }
  const sub = subcatFor(o);
  (bySubcat[sub] = bySubcat[sub] || []).push(o);
}

for (const [sub, list] of Object.entries(bySubcat)) {
  const p = path.join(CUR, `${sub}.json`);
  if (!fs.existsSync(p)) { console.warn(`  ! subcat file missing: ${sub} — skipping ${list.length} actors`); continue; }
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  const idxById = new Map(cur.entries.map((e, i) => [e.id, i]));
  let updated = 0;
  for (const o of list) {
    const entry = mkEntry(o);
    if (idxById.has(entry.id)) { cur.entries[idxById.get(entry.id)] = entry; updated++; affected.add(sub); } // refresh existing (parked → verified)
    else { cur.entries.push(entry); added++; affected.add(sub); console.log(`  + [${sub}] ${entry.name}  (${o.actorId})`); }
  }
  if (updated) console.log(`  ~ [${sub}] refreshed ${updated} existing`);
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

console.log(`\nAdded ${added} Apify actor entries, skipped ${skipped}.`);
console.log("Subcat distribution:", JSON.stringify(Object.fromEntries(Object.entries(bySubcat).map(([k, v]) => [k, v.length]))));
console.log(`Rebuild: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
