/**
 * add-sponge.mjs — fold the Sponge-provided x402 endpoints pay-tested in sponge-paytest.mjs into the
 * registry curation. Verified endpoints become Service entries with a verified `usage` block; fal (broken
 * charge-then-403), freepik (throttled), and pplx-agent (needs-input) are recorded with the right status.
 * curate.mjs/teams.mjs then stamp team:"Sponge" by host (these are Sponge-operated proxies, NOT firstParty).
 *
 * Run: node scripts/registry/add-sponge.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/sponge-fp");
const CURATION = join(__dir, "curation");
const DRY = process.argv.includes("--dry");
const TODAY = "2026-06-18";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// spend log → real cost/status per label
const SPEND = {};
for (const l of readFileSync(join(ROOT, "data/registry/qa-spend-log.jsonl"), "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.label) SPEND[j.label] = j; } catch {} }

const SPONGE_QUIRK = "Served via Sponge's x402 gateway (*.x402.paysponge.com) — a single x402 payment proxies the upstream provider. No API key. Base or Solana USDC.";

// Per-endpoint: verified entries. {label:[name, subcat, desc, tags[], method, inputExample, resultPull?, extraQuirk?]}
const V = {
  // Wolfram Alpha
  "wolframalpha-v1-result": ["Wolfram Alpha Short Answer", "web-search-apis", "Single plain-text answer to a natural-language or math query via Wolfram|Alpha.", ["knowledge", "compute", "answers"], "GET", { i: "2+2" }],
  "wolframalpha-v1-simple": ["Wolfram Alpha Simple", "web-search-apis", "Returns a simple visual (image) answer to a Wolfram|Alpha query.", ["knowledge", "compute"], "GET", { i: "2+2" }],
  "wolframalpha-v2-query": ["Wolfram Alpha Full Query", "web-search-apis", "Full structured Wolfram|Alpha result pods (JSON) for a query.", ["knowledge", "compute", "answers"], "GET", { input: "2+2", output: "json" }],
  // RentCast (real-estate data)
  "rentcast-avm-value": ["RentCast Property Value Estimate", "stocks-financial-data", "Automated valuation (AVM) sale-price estimate for a property by address.", ["real-estate", "valuation", "property-data"], "GET", { address: "5500 Grand Lake Dr, San Antonio, TX, 78244" }],
  "rentcast-avm-rent-long-term": ["RentCast Rent Estimate", "stocks-financial-data", "Long-term rent estimate (AVM) for a property by address.", ["real-estate", "rent", "property-data"], "GET", { address: "5500 Grand Lake Dr, San Antonio, TX, 78244" }],
  "rentcast-properties": ["RentCast Property Records", "stocks-financial-data", "Property records (beds/baths/size/owner/history) by address.", ["real-estate", "property-data"], "GET", { address: "5500 Grand Lake Dr, San Antonio, TX, 78244" }],
  "rentcast-properties-random": ["RentCast Random Properties", "stocks-financial-data", "Sample of random property records (for discovery/testing).", ["real-estate", "property-data"], "GET", { limit: "1" }],
  "rentcast-listings-sale": ["RentCast Sale Listings", "stocks-financial-data", "Active for-sale property listings filtered by city/state/zip.", ["real-estate", "listings"], "GET", { city: "San Antonio", state: "TX", limit: "1" }],
  "rentcast-listings-rental-long-term": ["RentCast Rental Listings", "stocks-financial-data", "Active long-term rental listings filtered by city/state/zip.", ["real-estate", "listings", "rent"], "GET", { city: "San Antonio", state: "TX", limit: "1" }],
  "rentcast-markets": ["RentCast Market Statistics", "stocks-financial-data", "Aggregate sale & rental market statistics for a zip code.", ["real-estate", "market-data"], "GET", { zipCode: "78244" }],
  // Perplexity
  "pplx-search": ["Perplexity Search", "web-search-apis", "Web search returning ranked results with snippets, powered by Perplexity.", ["web-search", "research"], "POST", { query: "what is bitcoin", max_results: 3 }],
  "pplx-v1-async-sonar": ["Perplexity Sonar Deep Research — async", "web-search-apis", "Submit an async deep-research job (sonar-deep-research). Returns a job id; poll for the report.", ["web-search", "research", "async"], "POST", { request: { model: "sonar-deep-research", messages: [{ role: "user", content: "What is Bitcoin? One sentence." }] } }, "poll", "Async: only sonar-deep-research is allowed; body must be { request: {model, messages} }. Submit returns a job id; result via poll."],
  // Deepgram
  "deepgram-v1-speak": ["Deepgram Aura TTS", "voice-tts", "Text-to-speech with Deepgram Aura voices. Body { text }.", ["tts", "voice", "audio"], "POST", { text: "Hello, how are you today?" }],
  "deepgram-v1-listen": ["Deepgram Nova Speech-to-Text", "speech-to-text", "Transcribe audio from a URL with Deepgram Nova. Body { url }.", ["stt", "transcription", "audio"], "POST", { url: "https://dpgr.am/spacewalk.wav" }],
  "deepgram-v1-read": ["Deepgram Text Intelligence", "nlp-text-analysis", "Summarize / extract topics / intents / sentiment from text. Pass { text } (or { url }) + ≥1 feature as query params (language, summarize, sentiment, topics, intents).", ["nlp", "summarization", "sentiment"], "POST", { text: "Bitcoin is a decentralized digital currency created in 2009 by Satoshi Nakamoto." }, "sync", "language + at least one feature (summarize/topics/intents/sentiment) are QUERY params, not body. A remote { url } must be publicly fetchable (some hosts 403 Deepgram's fetcher) — passing { text } is most reliable."],
  // Tripadvisor (location/POI data)
  "tripadvisor-api-v1-location-search": ["Tripadvisor Location Search", "maps-geolocation", "Search Tripadvisor locations (hotels/restaurants/attractions) by query; returns location_id + names.", ["travel", "places", "poi"], "GET", { searchQuery: "Vancouver" }],
  "tripadvisor-api-v1-location-nearby-search": ["Tripadvisor Nearby Search", "maps-geolocation", "Find Tripadvisor locations near a lat/long.", ["travel", "places", "poi", "geo"], "GET", { latLong: "49.2827,-123.1207" }],
  "tripadvisor-api-v1-location-locationid-details": ["Tripadvisor Location Details", "maps-geolocation", "Full details for a Tripadvisor location by id (address, rating, hours, etc.).", ["travel", "places", "poi"], "GET", { locationId: "154943 (from /location/search)" }, "sync", "locationId is a PATH param — get it from /location/search first."],
  "tripadvisor-api-v1-location-locationid-reviews": ["Tripadvisor Location Reviews", "maps-geolocation", "Recent reviews for a Tripadvisor location by id.", ["travel", "places", "reviews"], "GET", { locationId: "154943 (from /location/search)" }, "sync", "locationId is a PATH param — get it from /location/search first."],
  "tripadvisor-api-v1-location-locationid-photos": ["Tripadvisor Location Photos", "maps-geolocation", "Photos for a Tripadvisor location by id.", ["travel", "places", "photos"], "GET", { locationId: "154943 (from /location/search)" }, "sync", "locationId is a PATH param — get it from /location/search first."],
  // E2B
  "e2b-sandboxes": ["E2B Create Sandbox", "sandbox-environments", "Create an E2B cloud sandbox (isolated VM for running agent code). Body { templateID }.", ["sandbox", "code-execution", "compute"], "POST", { templateID: "base" }, "sync", "templateID is required (e.g. \"base\"). Returns a sandbox id used for subsequent (non-indexed) exec calls."],
};

// underlying brand per host
const BRAND = { "wolframalpha.x402.paysponge.com": ["Wolfram Alpha", "https://products.wolframalpha.com/api"], "rentcast.x402.paysponge.com": ["RentCast", "https://developers.rentcast.io"], "pplx.x402.paysponge.com": ["Perplexity", "https://docs.perplexity.ai"], "deepgram.x402.paysponge.com": ["Deepgram", "https://developers.deepgram.com"], "tripadvisor.x402.paysponge.com": ["Tripadvisor", "https://tripadvisor-content-api.readme.io"], "e2b.x402.paysponge.com": ["E2B", "https://e2b.dev/docs"], "freepik.x402.paysponge.com": ["Freepik", "https://docs.freepik.com"], "fal.x402.paysponge.com": ["fal.ai", "https://fal.ai/models"] };

async function probeAccepts(url, method) {
  const opts = { method, headers: { "User-Agent": UA, Accept: "application/json" } };
  if (method !== "GET") { opts.headers["Content-Type"] = "application/json"; opts.body = "{}"; }
  try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); const h = r.headers.get("payment-required"); const pr = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; return pr?.accepts || []; } catch { return []; }
}
function outputShape(label) { const p = join(ART, `${label}.json`); if (!existsSync(p)) return "body"; try { const j = JSON.parse(readFileSync(p, "utf8")); if (j && typeof j === "object") { if ("data" in j) return "body.data"; if ("results" in j) return "body.results"; if ("url" in j) return "body.url"; } } catch {} return "body"; }
const baseUrlOf = (label) => { const m = SPEND[label]; return m?.url; };

const entriesBySubcat = {};
const summary = [];

for (const [label, def] of Object.entries(V)) {
  const [name, subcat, desc, tags, method, inputExample, resultPull, extraQuirk] = def;
  const meta = existsSync(join(ART, `${label}.meta.json`)) ? JSON.parse(readFileSync(join(ART, `${label}.meta.json`), "utf8")) : {};
  const sp = SPEND[label] || {};
  const url = meta.url || sp.url;
  if (!url) { console.log(`  ! ${label}: no url; skip`); continue; }
  const host = new URL(url).host;
  const [brand, docs] = BRAND[host] || [host, null];
  const cost = sp.costUsd ?? meta.costUsd ?? null;
  const accepts = await probeAccepts(url, method);
  const callShape = method === "GET" ? `GET ${url.split("?")[0]} with query params (x402)` : `POST ${url} with JSON body (x402)`;
  const quirks = [SPONGE_QUIRK]; if (extraQuirk) quirks.push(extraQuirk);
  // service identity = the brand (Deepgram/Wolfram/…); backend.provider = the gateway serving it = Sponge
  // (one of possibly many providers). team:"Sponge" is stamped by host in curate.mjs; firstParty stays false.
  const backend = { url, method, provider: "Sponge", providerId: "sponge", amount: cost, accepts, probe: { status: 402, method, payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "active" };
  const entry = {
    name, kind: "api", provider: brand, providerId: slug(brand), aka: [label, slug(name)].filter((v, i, a) => a.indexOf(v) === i),
    description: desc, tags, modality: { input: ["text"], output: subcat === "voice-tts" ? ["audio"] : ["json"] },
    backends: [backend], docs,
    usage: { status: "verified", verifiedAt: TODAY, resultPull: resultPull || "sync", auth: "none", callShape, inputExample, outputShape: outputShape(label), quirks, guide: `${desc} ${SPONGE_QUIRK}`, costObservedUsd: cost },
    status: "active",
  };
  (entriesBySubcat[subcat] ||= []).push(entry);
  summary.push(`${subcat} ← ${name} ($${cost})`);
}

// ---- fal.ai: broken (charge-then-403, exhausted upstream balance) — one representative hidden record ----
const falModels = ["fast-sdxl", "flux/schnell", "flux/dev", "flux-pro/v1.1", "flux-pro/v1.1-ultra", "recraft-v3", "stable-diffusion-v35-large", "minimax/video-01", "stable-video"];
entriesBySubcat["image-generation"] ||= [];
entriesBySubcat["image-generation"].push({
  name: "fal.ai Image & Video (via Sponge)", kind: "api", provider: "fal.ai", providerId: "fal-ai", aka: ["fal-sponge", "fal-x402-paysponge"],
  description: `fal.ai image/video models proxied by Sponge at fal.x402.paysponge.com (${falModels.join(", ")}). NOT CALLABLE: every model charges the x402 fee then returns 403 'User is locked. Reason: Exhausted balance' — Sponge's upstream fal account is out of credit (charge-then-fail). Re-test later; if Sponge tops up, un-hide.`,
  tags: ["image-generation", "video-generation", "broken"], modality: { input: ["text"], output: ["image", "video"] },
  backends: [{ url: "https://fal.x402.paysponge.com/fal-ai/flux/schnell", method: "POST", provider: "Sponge", providerId: "sponge", amount: 0.01, accepts: [], probe: { status: 403, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "hidden" }],
  docs: "https://fal.ai/models",
  usage: { status: "broken", verifiedAt: TODAY, resultPull: "none", auth: "none", callShape: "POST fal.x402.paysponge.com/fal-ai/<model>", inputExample: { prompt: "a red circle" }, outputShape: "n/a", quirks: ["charge-then-403: Sponge's upstream fal.ai account balance is exhausted ('User is locked'). Paid 3/9 to confirm; the rest left un-paid."], guide: "Not callable — see droppedReason.", droppedReason: "charge-then-403 (Sponge fal upstream balance exhausted) — confirmed 2026-06-18", costObservedUsd: 0.01 },
  status: "hidden", hiddenReason: "broken",
});
summary.push(`image-generation ← fal.ai (Sponge proxy) [HIDDEN: broken charge-then-403]`);

// ---- freepik: throttled (429) — needs-review ----
entriesBySubcat["image-generation"].push({
  name: "Freepik Text-to-Image FLUX dev", kind: "api", provider: "Freepik", providerId: "freepik", aka: ["freepik-flux-dev-sponge"],
  description: "Freepik text-to-image (FLUX dev) via Sponge's x402 gateway. Verified live (402) but our paid test hit a persistent 429 (Sponge's freepik proxy is rate-limited). Parked for re-test.",
  tags: ["image-generation", "freepik", "flux"], modality: { input: ["text"], output: ["image"] },
  backends: [{ url: "https://freepik.x402.paysponge.com/v1/ai/text-to-image/flux-dev", method: "POST", provider: "Sponge", providerId: "sponge", amount: 0.02, accepts: await probeAccepts("https://freepik.x402.paysponge.com/v1/ai/text-to-image/flux-dev", "POST"), probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "needs-review" }],
  docs: "https://docs.freepik.com",
  usage: { status: "untested", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: "POST freepik.x402.paysponge.com/v1/ai/text-to-image/flux-dev with { prompt }", inputExample: { prompt: "a red circle" }, outputShape: "body", quirks: [SPONGE_QUIRK, "Paid test returned 429 (rate-limited) repeatedly — Sponge's freepik proxy throttle. Re-test later."], guide: "Likely { prompt } body; re-verify after throttle clears.", droppedReason: "429 throttle on paid test", costObservedUsd: 0.02 },
  status: "hidden", hiddenReason: "needs-review",
});
summary.push(`image-generation ← Freepik FLUX dev (Sponge) [needs-review: 429 throttle]`);

// ---- perplexity agent: needs-input (model/preset undetermined) ----
(entriesBySubcat["web-search-apis"] ||= []).push({
  name: "Perplexity Agent", kind: "api", provider: "Perplexity", providerId: "perplexity", aka: ["pplx-agent-sponge"],
  description: "Perplexity Agent API via Sponge's x402 gateway. Live (402) but requires a supported agent model/preset we couldn't determine (sonar & sonar-pro both rejected at $0.01/attempt). Parked pending the correct agent model.",
  tags: ["web-search", "agent", "research"], modality: { input: ["text"], output: ["json"] },
  backends: [{ url: "https://pplx.x402.paysponge.com/v1/agent", method: "POST", provider: "Sponge", providerId: "sponge", amount: 0.01, accepts: await probeAccepts("https://pplx.x402.paysponge.com/v1/agent", "POST"), probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "needs-review" }],
  docs: "https://docs.perplexity.ai",
  usage: { status: "untested", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: "POST pplx.x402.paysponge.com/v1/agent with { model|models|preset, input }", inputExample: { model: "<supported-agent-model>", input: "..." }, outputShape: "body", quirks: [SPONGE_QUIRK, "Requires model|models|preset; 'sonar' and 'sonar-pro' were rejected. Determine the supported agent model before paying."], guide: "Needs the correct agent model/preset.", droppedReason: "unknown supported agent model", costObservedUsd: 0 },
  status: "hidden", hiddenReason: "needs-input",
});
summary.push(`web-search-apis ← Perplexity Agent (Sponge) [needs-input: unknown model]`);

// ---- merge into curation/<subcat>.json (replace by slug(name)) ----
const CAT_FOR = { "web-search-apis": "data-intelligence", "stocks-financial-data": "data-intelligence", "voice-tts": "media-generation", "speech-to-text": "media-generation", "nlp-text-analysis": "data-intelligence", "maps-geolocation": "data-intelligence", "sandbox-environments": "developer-infrastructure", "image-generation": "media-generation" };
const affected = new Set();
for (const [subcat, entries] of Object.entries(entriesBySubcat)) {
  const path = join(CURATION, subcat + ".json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { subcategory: subcat, category: CAT_FOR[subcat] || "data-intelligence", unit: "per call", entries: [] };
  const existing = file.entries || [];
  const bySlugName = new Map(existing.map((e) => [slug(e.name), e]));
  let added = 0, replaced = 0;
  for (const e of entries) { const k = slug(e.name); if (bySlugName.has(k)) { existing[existing.indexOf(bySlugName.get(k))] = e; replaced++; } else { existing.push(e); added++; } }
  file.entries = existing;
  if (!DRY) writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  affected.add(subcat);
  console.log(`  ${subcat}: +${added} new, ~${replaced} replaced (now ${existing.length})`);
}
console.log("\n--- summary ---"); summary.forEach((s) => console.log("  " + s));
console.log(`\nAffected subcats: ${[...affected].join(" ")}`);
console.log(`Next: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
