/**
 * fp-paytest.mjs — pay-test + document the first-party providers the user asked to index
 * (Messari, Zerion, Pinata + the 4 remaining CoinGecko endpoints).
 *
 * Probe-driven: for endpoints that advertise a `bazaar` extension in their x402 402 (Messari),
 * we first do a FREE unpaid probe to read the exact input shape, then pay with those params. For plain
 * endpoints (Zerion GET, CoinGecko GET) we pay directly. Pinata is a special multi-step flow.
 *
 * Money-safe: delegates every charge to qa-pay.mjs (ceiling + 402-gate + spend log). Idempotent:
 * skips any endpoint whose artifact already shows paid:true.
 *
 * Usage: node scripts/registry/fp-paytest.mjs --group=coingecko|pinata|zerion|messari [--cap=2] [--dry]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/fp-batch");
mkdirSync(ART, { recursive: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const GROUP = arg("group", "");
const CAP = arg("cap", "2");
const DRY = flag("dry");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const VITALIK = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

const RESULTS = join(ART, `_results-${GROUP}.json`);
const out = [];

function decodePR(headerB64) { try { return JSON.parse(Buffer.from(headerB64, "base64").toString("utf8")); } catch { return null; } }

// When a paid response is too big for qa-pay's stdout line, reconstruct the result from the saved
// artifact body + the spend log (authoritative for cost/status/txHash).
function recoverFromArtifact(label, artifact) {
  if (!existsSync(artifact)) return null;
  let body; try { body = JSON.parse(readFileSync(artifact, "utf8")); } catch { body = null; }
  let sp = {};
  try {
    const lines = readFileSync(join(ROOT, "data/registry/qa-spend-log.jsonl"), "utf8").split("\n").filter(Boolean);
    for (const l of lines) { try { const j = JSON.parse(l); if (j.label === label) sp = j; } catch {} }
  } catch {}
  const status = sp.status;
  const ok = status >= 200 && status < 300 && (!body || body.error == null || body.data != null);
  return { label, classification: ok ? "ok-paid" : "http-error", ok, status, paid: sp.costUsd != null, costUsd: sp.costUsd, network: sp.network || "base", txHash: sp.txHash || null, recovered: true };
}

// Free unpaid probe → { status, pr (decoded payment-required), bazaar }
async function probe(url, method = "GET", body = null) {
  const opts = { method, headers: { "User-Agent": UA, Accept: "application/json" } };
  if (body != null) { opts.headers["Content-Type"] = "application/json"; opts.body = typeof body === "string" ? body : JSON.stringify(body); }
  const r = await fetch(url, opts).catch((e) => ({ status: 0, _err: String(e), headers: new Map() }));
  const prHeader = r.headers?.get?.("payment-required");
  const pr = prHeader ? decodePR(prHeader) : null;
  const bazaar = pr?.extensions?.bazaar || null;
  return { status: r.status, pr, bazaar };
}

// Pay via qa-pay.mjs → parsed result line. Idempotent on artifact.
function pay({ url, method = "GET", body = null, label, cap = CAP }) {
  const artifact = join(ART, `${label}.json`);
  const meta = join(ART, `${label}.meta.json`);
  if (existsSync(meta)) {
    const prev = JSON.parse(readFileSync(meta, "utf8"));
    if (prev.paid || prev.classification === "ok-free") { console.log(`  · skip (done): ${label}`); out.push(prev); return prev; }
  }
  const args = [join(ROOT, "scripts/registry/dist/qa-pay.mjs"), `--url=${url}`, `--method=${method}`, `--cap=${cap}`, `--save=${artifact}`, `--label=${label}`];
  if (body != null) args.push(`--body=${typeof body === "string" ? body : JSON.stringify(body)}`);
  if (DRY) { console.log(`  DRY ${label}: ${method} ${url}${body ? " body=" + JSON.stringify(body) : ""}`); return null; }
  let line;
  try {
    const stdout = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
    try {
      line = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
    } catch {
      line = recoverFromArtifact(label, artifact); // big response overflowed stdout; trust artifact + spend log
    }
  } catch (e) {
    line = recoverFromArtifact(label, artifact) || { label, classification: "exception", ok: false, error: String(e.message || e).slice(0, 300) };
  }
  writeFileSync(meta, JSON.stringify(line, null, 2));
  const tag = line.classification + (line.costUsd != null ? ` $${line.costUsd}` : "") + (line.status ? ` [${line.status}]` : "");
  console.log(`  ${line.ok ? "✓" : "✗"} ${label}: ${tag}`);
  out.push(line);
  return line;
}

async function getJson(url, method = "GET", headers = {}, body = null) {
  const opts = { method, headers: { "User-Agent": UA, Accept: "application/json", ...headers } };
  if (body != null) opts.body = body;
  const r = await fetch(url, opts);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, text };
}

// ---------------- CoinGecko (remaining 3; simple-price already done in smoke) ----------------
async function coingecko() {
  const B = "https://pro-api.coingecko.com/api/v3/x402";
  const WETH = "0x4200000000000000000000000000000000000006";
  pay({ url: `${B}/onchain/search/pools?query=aerodrome&network=base&include=base_token,quote_token,dex&page=1`, method: "GET", label: "coingecko-search-pools", cap: "1" });
  pay({ url: `${B}/onchain/networks/base/trending_pools?duration=1h&include=base_token,quote_token,dex&page=1`, method: "GET", label: "coingecko-trending-pools", cap: "1" });
  pay({ url: `${B}/onchain/networks/base/tokens/${WETH}?include=top_pools&include_composition=true`, method: "GET", label: "coingecko-token-data", cap: "1" });
}

// ---------------- Pinata (pin public/private + retrieve private) ----------------
async function pinata() {
  const B = "https://402.pinata.cloud/v1";
  for (const net of ["public", "private"]) {
    const label = `pinata-pin-${net}`;
    // Unique content per file so Pinata content-addressing doesn't dedupe public↔private.
    const payload = `MasterKey x402 1P indexing test (${net}) nonce=${Date.now()}-${net} ` + "x".repeat(48);
    const fileSize = Buffer.byteLength(payload);
    // Beyond-surface: fileSize is a QUERY param, not a JSON body (docs say body — wrong).
    const r = pay({ url: `${B}/pin/${net}?fileSize=${fileSize}`, method: "POST", label, cap: "1" });
    if (!r || !r.ok) continue;
    // r.bodyPreview / artifact holds { url: presigned }
    let presigned = r.bodyPreview?.url;
    try { if (!presigned) presigned = JSON.parse(readFileSync(join(ART, `${label}.json`), "utf8")).url; } catch {}
    if (!presigned) { console.log(`    ! ${label}: no presigned url in response`); continue; }
    // Upload the file via multipart FormData to the presigned URL (free, non-x402).
    try {
      const fd = new FormData();
      fd.append("file", new Blob([payload], { type: "text/plain" }), `mk-test-${net}.txt`);
      const up = await fetch(presigned, { method: "POST", body: fd });
      const upText = await up.text(); let upJson; try { upJson = JSON.parse(upText); } catch { upJson = upText; }
      writeFileSync(join(ART, `${label}.upload.json`), JSON.stringify({ status: up.status, body: upJson }, null, 2));
      const cid = upJson?.data?.cid || upJson?.cid || upJson?.IpfsHash || upJson?.data?.IpfsHash;
      console.log(`    upload ${net}: status=${up.status} cid=${cid}`);
      if (net === "private" && cid) {
        pay({ url: `${B}/retrieve/private/${cid}`, method: "GET", label: "pinata-retrieve-private", cap: "1" });
      }
    } catch (e) { console.log(`    ! upload ${net} failed: ${String(e.message || e).slice(0, 200)}`); }
  }
}

// ---------------- Zerion (core wallet GET endpoints, $0.01) ----------------
async function zerion() {
  const B = "https://api.zerion.io/v1";
  const eps = [
    [`/wallets/${VITALIK}/portfolio`, "zerion-wallet-portfolio"],
    [`/wallets/${VITALIK}/positions?filter[positions]=only_simple&currency=usd&page[size]=20`, "zerion-wallet-positions"],
    [`/wallets/${VITALIK}/transactions?currency=usd&page[size]=10`, "zerion-wallet-transactions"],
    [`/wallets/${VITALIK}/pnl/?currency=usd`.replace(/\/$/, ""), "zerion-wallet-pnl"],
    [`/wallets/${VITALIK}/charts/day?currency=usd`, "zerion-wallet-chart"],
    [`/wallets/${VITALIK}/nft-positions?currency=usd&page[size]=10`, "zerion-wallet-nft-positions"],
    [`/fungibles/?currency=usd&page[size]=10`.replace(/\/$/, ""), "zerion-fungibles"],
    [`/chains/`.replace(/\/$/, ""), "zerion-chains"],
  ];
  for (const [path, label] of eps) {
    const url = `${B}${path}`;
    const pr = await probe(url, "GET");
    if (pr.status !== 402) { console.log(`  ? ${label}: probe status=${pr.status} (not 402; skipping pay)`); out.push({ label, classification: "no-402", status: pr.status }); writeFileSync(join(ART, `${label}.meta.json`), JSON.stringify({ label, classification: "no-402", status: pr.status })); continue; }
    pay({ url, method: "GET", label, cap: "1" });
  }
}

// ---------------- Messari (full sweep: 34 concrete + representative wildcards) ----------------
async function messari() {
  const B = "https://api.messari.io";
  // Concrete endpoints. We probe each (free) to read its bazaar input example, then pay with it.
  const concrete = [
    "/metrics/v2/assets", "/metrics/v2/assets/metrics", "/metrics/v2/networks", "/metrics/v2/networks/metrics",
    "/metrics/v2/stablecoins", "/metrics/v2/stablecoins/metrics", "/metrics/v1/exchanges", "/metrics/v1/exchanges/metrics",
    "/metrics/v1/markets", "/metrics/v1/markets/metrics", "/news/v1/news/sources",
    "/metrics/v2/assets/details", "/metrics/v2/assets/ath", "/metrics/v2/assets/roi",
    "/funding/v1/funds", "/funding/v1/funds/managers", "/funding/v1/mergers-and-acquisitions",
    "/funding/v1/organizations", "/funding/v1/projects", "/funding/v1/rounds", "/funding/v1/rounds/investors",
    "/news/v1/news/feed", "/signal/v1/assets", "/signal/v1/assets/mindshare-gainers-24h",
    "/signal/v1/assets/mindshare-gainers-7d", "/signal/v1/assets/mindshare-losers-24h",
    "/signal/v1/assets/mindshare-losers-7d", "/signal/v1/assets/time-series/1d", "/signal/v1/assets/time-series/1h",
    "/signal/v1/x-users", "/signal/v1/x-users/time-series/1d", "/token-unlocks/v1/allocations", "/token-unlocks/v1/assets",
  ];
  // Wildcard representatives (resolved to a concrete slug/value).
  const wild = [
    "/metrics/v2/assets/bitcoin/metrics/price/time-series/1d",
    "/metrics/v2/networks/ethereum/metrics/activity/time-series/1d",
    "/signal/v1/assets/bitcoin",
    "/token-unlocks/v1/assets/aptos/events",
    "/token-unlocks/v1/assets/aptos/unlocks",
    "/token-unlocks/v1/assets/aptos/vesting-schedule",
  ];
  const all = [...concrete, ...wild];
  const now = Math.floor(Date.now ? 0 : 0); // Date.now unavailable in workflows; not here though
  const start = "2026-05-01", end = "2026-06-01";
  for (const path of all) {
    const label = "messari" + path.replace(/\//g, "-").replace(/-+/g, "-");
    let url = B + path;
    // probe to read the bazaar input (method + queryParams example)
    const pr = await probe(url, "GET");
    let method = "GET";
    if (pr.status === 402 && pr.bazaar?.info?.input) {
      const inp = pr.bazaar.info.input;
      method = (inp.method || "GET").toUpperCase();
      const qp = inp.queryParams || {};
      const params = new URLSearchParams();
      for (let [k, v] of Object.entries(qp)) {
        if (Array.isArray(v)) v = v[0]; // bazaar gives arrays for repeatable params; one value is fine
        let s = String(v);
        // Beyond-surface: funding endpoints want RFC3339 datetimes; bazaar examples give bare YYYY-MM-DD → 400.
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
        params.set(k, s);
      }
      // time-series need start/end; ensure present (RFC3339)
      if (path.includes("time-series")) { if (!params.has("start")) params.set("start", start + "T00:00:00Z"); if (!params.has("end")) params.set("end", end + "T00:00:00Z"); }
      // token-unlocks unlocks/vesting-schedule: real params are startTime/endTime (bazaar wrongly says
      // startDate/endDate) + an interval enum.
      if (/\/(unlocks|vesting-schedule)$/.test(path)) {
        if (params.has("startDate")) { params.set("startTime", params.get("startDate") + (/T/.test(params.get("startDate")) ? "" : "T00:00:00Z")); params.delete("startDate"); }
        if (params.has("endDate")) { params.set("endTime", params.get("endDate") + (/T/.test(params.get("endDate")) ? "" : "T00:00:00Z")); params.delete("endDate"); }
        if (!params.has("startTime")) params.set("startTime", start + "T00:00:00Z");
        if (!params.has("endTime")) params.set("endTime", end + "T00:00:00Z");
        params.set("interval", "MONTHLY");
      }
      // Funding: the bazaar examples include placeholder entity-id filters (managerId=org-001 etc.) that
      // 400 with "Invalid ID". Drop them — the endpoints return all rows without the filter.
      if (path.startsWith("/funding/")) { for (const k of ["managerId", "investorId", "fundedEntityId", "id", "acquiredEntityId", "acquiringEntityId"]) params.delete(k); }
      // ath/roi 500 on the kitchen-sink example (search+ids+slugs+category+sector+tags together). Minimal.
      if (/\/assets\/(ath|roi)$/.test(path)) { for (const k of [...params.keys()]) params.delete(k); params.set("slugs", "bitcoin,ethereum"); }
      const qs = params.toString();
      if (method === "GET" && qs) url += (url.includes("?") ? "&" : "?") + qs;
      writeFileSync(join(ART, `${label}.probe.json`), JSON.stringify({ accepts: pr.pr?.accepts, bazaar: pr.bazaar }, null, 2));
    } else if (pr.status !== 402) {
      console.log(`  ? ${label}: probe status=${pr.status} (not 402)`); out.push({ label, classification: "no-402", status: pr.status });
      writeFileSync(join(ART, `${label}.meta.json`), JSON.stringify({ label, classification: "no-402", status: pr.status })); continue;
    }
    pay({ url, method, label, cap: CAP });
  }
}

const groups = { coingecko, pinata, zerion, messari };
if (!groups[GROUP]) { console.error("specify --group=" + Object.keys(groups).join("|")); process.exit(1); }
console.log(`\n=== fp-paytest group=${GROUP} cap=${CAP} ${DRY ? "(DRY)" : ""} ===`);
await groups[GROUP]();
writeFileSync(RESULTS, JSON.stringify(out, null, 2));
const paid = out.filter((r) => r.paid);
const spent = paid.reduce((s, r) => s + (r.costUsd || 0), 0);
console.log(`\n--- ${GROUP}: ${out.length} endpoints | ${paid.length} paid | ~$${spent.toFixed(4)} (qa-pay self-report) ---`);
console.log(`results: ${RESULTS}`);
