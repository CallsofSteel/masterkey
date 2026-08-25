/**
 * sponge-paytest.mjs — pay-test + document the Sponge-provided (gateway) x402 endpoints.
 *
 * Target: data/registry/qa-artifacts/sponge-fp/target-sponge-mainnet.json (built by sponge-scope.mjs:
 *   live, Base-mainnet-payable, deduped). Per-provider input builders construct a minimal VALID call
 *   (image→prompt, deepgram→text/audio, rentcast→address, wolfram→i=, tripadvisor→searchQuery + a
 *   locationId resolved from a search call). Pays via qa-pay.mjs (cap=$1/call + an $8 sprint backstop).
 *   Idempotent on artifacts. NO endpoint here quotes >$1; if one ever does, qa-pay REFUSES (over-cap).
 *
 * Usage: node scripts/registry/sponge-paytest.mjs [--cap=1] [--only=fal,deepgram] [--dry]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/sponge-fp");
mkdirSync(ART, { recursive: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const CAP = arg("cap", "1");
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const DRY = flag("dry");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Sample inputs for endpoints that need real values.
const S = {
  imgPrompt: "a single red circle on a white background",
  vidPrompt: "a cat slowly walking across a sunny room",
  image: "https://storage.googleapis.com/falserverless/model_tests/video_models/robot.png",
  audio: "https://dpgr.am/spacewalk.wav",
  textUrl: "https://en.wikipedia.org/wiki/Bitcoin",
  address: "5500 Grand Lake Dr, San Antonio, TX, 78244",
  zip: "78244",
};

// Per-pathname builder: returns { body } for POST or { query } for GET. null = skip (needs-input).
function build(r, ctx) {
  const u = new URL(r.url);
  const p = u.pathname;
  const host = u.host;
  // ---- fal.ai: BROKEN via Sponge — the proxy's upstream fal account is balance-exhausted, so every
  //      model charges then 403s ("User is locked. Reason: Exhausted balance"). Don't pay; mark broken.
  if (host.startsWith("fal.")) return { _broken: "charge-then-403: Sponge's fal upstream balance exhausted (fal.ai 403 'User is locked')" };
  // ---- Deepgram ----
  if (host.startsWith("deepgram.")) {
    if (/\/speak$/.test(p)) return { body: { text: "Hello, how are you today?" } }; // TTS
    if (/\/listen$/.test(p)) return { body: { url: S.audio } }; // STT (audio URL)
    if (/\/read$/.test(p)) return { query: { language: "en", summarize: "true", sentiment: "true" }, body: { text: "Bitcoin is a decentralized digital currency created in 2009 by Satoshi Nakamoto. It runs on a peer-to-peer network without a central bank." } }; // text intel; language + ≥1 feature are QUERY params; pass text directly (a remote url can 403 deepgram's fetcher)
  }
  // ---- E2B ----
  if (host.startsWith("e2b.")) return { body: { templateID: "base" } }; // templateID required
  // ---- Freepik ----
  if (host.startsWith("freepik.")) return { body: { prompt: S.imgPrompt } };
  // ---- Perplexity ----
  if (host.startsWith("pplx.")) {
    if (/\/search$/.test(p)) return { body: { query: "what is bitcoin", max_results: 3 } };
    if (/\/v1\/agent$/.test(p)) return { _needsInput: "requires a supported agent model/preset we couldn't determine (sonar & sonar-pro both rejected); /search and /async/sonar verified working" };
    if (/\/async\/sonar$/.test(p)) return { body: { request: { model: "sonar-deep-research", messages: [{ role: "user", content: "What is Bitcoin? One sentence." }] } } }; // async only for sonar-deep-research
  }
  // ---- Wolfram Alpha (GET; query param differs by version) ----
  if (host.startsWith("wolframalpha.")) {
    if (/\/v2\/query$/.test(p)) return { query: { input: "2+2", output: "json" } };
    return { query: { i: "2+2" } }; // v1/result, v1/simple
  }
  // ---- RentCast (GET) ----
  if (host.startsWith("rentcast.")) {
    if (/\/properties\/random$/.test(p)) return { query: { limit: "1" } };
    if (/\/markets$/.test(p)) return { query: { zipCode: S.zip } };
    if (/\/listings\//.test(p)) return { query: { city: "San Antonio", state: "TX", limit: "1" } };
    return { query: { address: S.address } }; // avm/value, avm/rent/long-term, properties
  }
  // ---- Tripadvisor (GET; :locationId resolved from a prior search) ----
  if (host.startsWith("tripadvisor.")) {
    if (/\/location\/search$/.test(p)) return { query: { searchQuery: "Vancouver" } };
    if (/\/location\/nearby_search$/.test(p)) return { query: { latLong: "49.2827,-123.1207" } };
    if (p.includes(":locationId")) {
      if (!ctx.locationId) return null; // chain not resolved → needs-input
      return { _url: r.url.replace(":locationId", ctx.locationId), query: {} };
    }
  }
  return null;
}

function pay({ url, method, body, label }) {
  const artifact = join(ART, `${label}.json`);
  const meta = join(ART, `${label}.meta.json`);
  if (existsSync(meta)) { const prev = JSON.parse(readFileSync(meta, "utf8")); if (prev.paid || prev.ok) { console.log(`  · skip (done): ${label}`); return prev; } }
  const args = [join(ROOT, "scripts/registry/dist/qa-pay.mjs"), `--url=${url}`, `--method=${method}`, `--cap=${CAP}`, `--save=${artifact}`, `--label=${label}`];
  if (body != null) args.push(`--body=${JSON.stringify(body)}`);
  if (DRY) { console.log(`  DRY ${label}: ${method} ${url}${body ? " " + JSON.stringify(body) : ""}`); return null; }
  let line;
  try {
    const stdout = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, QA_SPRINT_CEILING: "8", QA_SPRINT_PREFIX: "sponge-" } });
    line = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
  } catch (e) { line = { label, classification: "exception", ok: false, error: String(e.message || e).slice(0, 200) }; }
  writeFileSync(meta, JSON.stringify({ ...line, url, method, label }, null, 2));
  console.log(`  ${line.ok ? "✓" : "✗"} ${label}: ${line.classification}${line.costUsd != null ? " $" + line.costUsd : ""}${line.status ? " [" + line.status + "]" : ""}${line.error ? " " + line.error : ""}`);
  return line;
}

const targets = JSON.parse(readFileSync(join(ART, "target-sponge-mainnet.json"), "utf8"))
  .filter((r) => !ONLY.length || ONLY.some((o) => new URL(r.url).host.startsWith(o)));

// Order tripadvisor search FIRST so its locationId can feed details/photos/reviews.
targets.sort((a, b) => (/location\/search/.test(b.url) ? 1 : 0) - (/location\/search/.test(a.url) ? 1 : 0));

const labelFor = (r) => { const u = new URL(r.url); return (u.host.split(".")[0] + u.pathname.replace(/\/$/, "").replace(/[^a-z0-9]+/gi, "-")).toLowerCase().replace(/^-+|-+$/g, ""); };
const ctx = { locationId: null };
console.log(`\n=== sponge-paytest: ${targets.length} endpoints cap=$${CAP} ${DRY ? "(DRY)" : ""} ===`);
const out = [];
for (const r of targets) {
  const spec = build(r, ctx);
  const label = labelFor(r);
  if (spec && spec._broken) { const mp = join(ART, `${label}.meta.json`); if (!existsSync(mp)) writeFileSync(mp, JSON.stringify({ label, classification: "broken", reason: spec._broken, url: r.url })); console.log(`  ⊘ broken (not paid): ${label} — ${spec._broken}`); out.push({ label, classification: "broken", reason: spec._broken, url: r.url }); continue; }
  if (spec && spec._needsInput) { writeFileSync(join(ART, `${label}.meta.json`), JSON.stringify({ label, classification: "needs-input", reason: spec._needsInput, url: r.url })); console.log(`  ⊘ needs-input (not paid): ${label} — ${spec._needsInput}`); out.push({ label, classification: "needs-input", reason: spec._needsInput, url: r.url }); continue; }
  if (!spec) { console.log(`  ⊘ needs-input: ${label}`); out.push({ label, classification: "needs-input", url: r.url }); writeFileSync(join(ART, `${label}.meta.json`), JSON.stringify({ label, classification: "needs-input", url: r.url })); continue; }
  const url = spec._url || (spec.query ? r.url + (r.url.includes("?") ? "&" : "?") + new URLSearchParams(spec.query) : r.url);
  const res = pay({ url, method: r.method, body: spec.body, label });
  if (res) out.push(res);
  // capture a tripadvisor locationId from the search result for the chained endpoints
  if (res && /tripadvisor.*location-search/.test(label) && res.ok) {
    try { const b = JSON.parse(readFileSync(join(ART, `${label}.json`), "utf8")); ctx.locationId = b?.data?.[0]?.location_id || b?.data?.data?.[0]?.location_id || null; console.log(`    → locationId=${ctx.locationId}`); } catch {}
  }
}
writeFileSync(join(ART, "_results-sponge.json"), JSON.stringify(out, null, 2));
const paid = out.filter((r) => r.paid);
console.log(`\n--- sponge: ${out.length} endpoints | ${out.filter((r) => r.ok).length} ok | ${paid.length} paid | ~$${paid.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(4)} ---`);
