/**
 * add-first-party.mjs — generate registry curation entries for the first-party providers pay-tested in
 * fp-paytest.mjs (CoinGecko, Pinata, Zerion, Messari) + a hidden Venice record.
 *
 * Reads each tested endpoint's meta (url/method/cost/status from qa-pay), re-probes it FREE (to capture
 * live payment.accepts + bazaar input/output schema + resource.description), and reads the saved response
 * artifact for a real output sample. Emits Service entries (with a verified `usage` block) merged into the
 * right curation/<subcat>.json. curate.mjs then stamps firstParty (provider+host already in first-party.json).
 *
 * Run: node scripts/registry/add-first-party.mjs            (writes curation files; prints affected subcats)
 *      node scripts/registry/add-first-party.mjs --dry      (preview only)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/fp-batch");
const CURATION = join(__dir, "curation");
const DRY = process.argv.includes("--dry");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TODAY = "2026-06-18";
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// spend log → authoritative cost/status/txHash per label
const SPEND = {};
for (const l of readFileSync(join(ROOT, "data/registry/qa-spend-log.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.label) SPEND[j.label] = j; } catch {}
}

const PROVIDERS = {
  coingecko: { provider: "CoinGecko", host: "pro-api.coingecko.com", docs: "https://docs.coingecko.com/reference/x402", baseQuirk: "First-party CoinGecko x402 endpoint — $0.01 flat, no API key (do NOT send x-cg-pro-api-key). Base or Solana USDC." },
  pinata: { provider: "Pinata", host: "402.pinata.cloud", docs: "https://docs.pinata.cloud/files/x402/intro", baseQuirk: "First-party Pinata x402 endpoint. Pay alone suffices (no JWT)." },
  zerion: { provider: "Zerion", host: "api.zerion.io", docs: "https://developers.zerion.io/build-with-ai/x402", baseQuirk: "First-party Zerion x402 ($0.01/call, no API key). GET the standard Zerion REST endpoint WITHOUT a trailing slash (a trailing slash 301-redirects). Base or Solana USDC." },
  messari: { provider: "Messari", host: "api.messari.io", docs: "https://docs.messari.io/api-reference/x402-payments", baseQuirk: "First-party Messari x402. ⚠️ Call with GET + query params (the docs say POST — that returns 403; only GET triggers the 402). No API key. Base/Solana/X-Layer USDC. Note: Messari charges BEFORE validating params, so a malformed request still costs — send valid params." },
};

// Per-label display metadata. name/desc/tags; subcat override; extra quirks. Missing → derived + 402 description.
const META = {
  // ---- CoinGecko (crypto-blockchain-data) ----
  "coingecko-simple-price": { name: "CoinGecko Simple Price", subcat: "crypto-blockchain-data", desc: "Price + market cap / 24h volume / 24h change for listed coins by symbol, name, or CoinGecko ID (batch up to 515).", tags: ["crypto-prices", "market-data"] },
  "coingecko-search-pools": { name: "CoinGecko Onchain Search Pools", subcat: "crypto-blockchain-data", desc: "Search DEX pools by token name, symbol, or contract address on a network; returns pool trading data + token metadata (resolves name/symbol→address).", tags: ["dex", "onchain", "crypto-prices"] },
  "coingecko-trending-pools": { name: "CoinGecko Onchain Trending Pools", subcat: "crypto-blockchain-data", desc: "Hottest DEX pools on a network right now, ranked by volume + transaction velocity. duration = 5m/1h/6h/24h.", tags: ["dex", "onchain", "trending"] },
  "coingecko-token-data": { name: "CoinGecko Onchain Token Data", subcat: "crypto-blockchain-data", desc: "Full single-token onchain profile by contract address: price, FDV, market cap, liquidity, volume + top pools (include=top_pools).", tags: ["dex", "onchain", "tokens", "market-data"] },
  // ---- Pinata (decentralized-ipfs) ----
  "pinata-pin-public": { name: "Pinata Pin Public File", subcat: "decentralized-ipfs", desc: "Pay to pin a public file to Pinata/IPFS. Returns a presigned upload URL; POST the file (multipart FormData) to it to get the CID.", tags: ["ipfs", "storage", "pinning"], resultPull: "sync" },
  "pinata-pin-private": { name: "Pinata Pin Private File", subcat: "decentralized-ipfs", desc: "Pay to pin a private file to Pinata. Returns a presigned upload URL; POST the file to it to get the CID. Retrieve later via the private-retrieve endpoint.", tags: ["ipfs", "storage", "pinning", "private"], resultPull: "sync" },
  "pinata-retrieve-private": { name: "Pinata Retrieve Private File", subcat: "decentralized-ipfs", desc: "Pay to get a temporary access URL for a private Pinata file by CID.", tags: ["ipfs", "storage", "retrieve", "private"] },
  // ---- Zerion (crypto-blockchain-data) ----
  "zerion-wallet-portfolio": { name: "Zerion Wallet Portfolio", subcat: "crypto-blockchain-data", desc: "Aggregated multichain portfolio value + breakdown for a wallet address.", tags: ["wallet-analytics", "portfolio", "onchain"] },
  "zerion-wallet-positions": { name: "Zerion Wallet Positions", subcat: "crypto-blockchain-data", desc: "All token positions held by a wallet across chains, with USD value, price, and 24h change.", tags: ["wallet-analytics", "positions", "onchain"] },
  "zerion-wallet-transactions": { name: "Zerion Wallet Transactions", subcat: "crypto-blockchain-data", desc: "Decoded transaction history for a wallet across chains.", tags: ["wallet-analytics", "transaction-history", "onchain"] },
  "zerion-wallet-pnl": { name: "Zerion Wallet PnL", subcat: "crypto-blockchain-data", desc: "Realized/unrealized profit-and-loss summary for a wallet.", tags: ["wallet-analytics", "pnl", "onchain"] },
  "zerion-wallet-chart": { name: "Zerion Wallet Balance Chart", subcat: "crypto-blockchain-data", desc: "Wallet total-value time series for a period (day/week/month/year).", tags: ["wallet-analytics", "chart", "onchain"] },
  "zerion-wallet-nft-positions": { name: "Zerion Wallet NFT Positions", subcat: "crypto-blockchain-data", desc: "NFT holdings for a wallet across chains, with floor-price valuation.", tags: ["wallet-analytics", "nft", "onchain"] },
  "zerion-fungibles": { name: "Zerion Fungibles", subcat: "crypto-blockchain-data", desc: "Browse/look up fungible tokens tracked by Zerion with market data.", tags: ["tokens", "market-data", "onchain"] },
  "zerion-chains": { name: "Zerion Chains", subcat: "crypto-blockchain-data", desc: "List of chains supported by Zerion with metadata.", tags: ["chains", "reference", "onchain"] },
};

// Free Messari endpoints (no 402) → reconstruct URL + index as free. Plus clean names for the paid ones.
const FREE_MESSARI = {
  "messari-metrics-v2-assets": ["/metrics/v2/assets?limit=20", "Messari Assets List", "crypto-blockchain-data", "Search/browse all Messari-tracked assets with filtering (name/symbol/slug/category/sector). FREE."],
  "messari-metrics-v2-assets-metrics": ["/metrics/v2/assets/metrics", "Messari Asset Metrics Catalog", "crypto-blockchain-data", "List of available asset time-series dataset slugs (price/volume/market-cap/futures-*). FREE."],
  "messari-metrics-v2-networks": ["/metrics/v2/networks?limit=20", "Messari Networks List", "crypto-blockchain-data", "List of blockchain networks with current activity/financial/stablecoin/ecosystem metrics. FREE."],
  "messari-metrics-v2-networks-metrics": ["/metrics/v2/networks/metrics", "Messari Network Metrics Catalog", "crypto-blockchain-data", "List of available network time-series datasets + metric slugs. FREE."],
  "messari-metrics-v2-stablecoins": ["/metrics/v2/stablecoins?limit=20", "Messari Stablecoins List", "crypto-blockchain-data", "Stablecoins tracked by Messari with supply/peg metrics. FREE."],
  "messari-metrics-v2-stablecoins-metrics": ["/metrics/v2/stablecoins/metrics", "Messari Stablecoin Metrics Catalog", "crypto-blockchain-data", "Available stablecoin time-series dataset/metric slugs. FREE."],
  "messari-metrics-v1-exchanges": ["/metrics/v1/exchanges", "Messari Exchanges List", "crypto-blockchain-data", "Exchanges tracked by Messari. FREE."],
  "messari-metrics-v1-markets": ["/metrics/v1/markets", "Messari Markets List", "crypto-blockchain-data", "Trading markets/pairs tracked by Messari. FREE."],
  "messari-news-v1-news-sources": ["/news/v1/news/sources", "Messari News Sources", "news-media", "Available crypto news sources (IDs/names/types) for the news feed. FREE."],
  "messari-token-unlocks-v1-assets": ["/token-unlocks/v1/assets", "Messari Token-Unlock Assets List", "crypto-blockchain-data", "Assets that have token-unlock/vesting data. FREE."],
};
Object.assign(META, {
  "messari-metrics-v2-assets-details": { name: "Messari Asset Details", subcat: "crypto-blockchain-data", desc: "Rich asset snapshot (market data, ATH, ROI, sector, contract addresses, links) for one or more ids/slugs.", tags: ["crypto", "market-data", "fundamentals", "institutional-data"] },
  "messari-metrics-v2-assets-ath": { name: "Messari Asset ATH", subcat: "crypto-blockchain-data", desc: "All-time-high price, date, % down from ATH, breakeven multiple, cycle low.", tags: ["crypto", "market-data", "ath"] },
  "messari-metrics-v2-assets-roi": { name: "Messari Asset ROI", subcat: "crypto-blockchain-data", desc: "Multi-timeframe price change (24h/7d/30d/1y/YTD) for assets, sortable.", tags: ["crypto", "market-data", "roi"] },
  "messari-metrics-v2-assets-bitcoin-metrics-price-time-series-1d": { name: "Messari Asset Metrics Time-Series", subcat: "crypto-blockchain-data", desc: "Historical asset metric time-series (price/volume/market-cap/futures) at 5m/15m/1h/1d. Path: /metrics/v2/assets/{slug}/metrics/{dataset}/time-series/{granularity}.", tags: ["crypto", "time-series", "market-data"] },
  "messari-metrics-v2-networks-ethereum-metrics-activity-time-series-1d": { name: "Messari Network Metrics Time-Series", subcat: "crypto-blockchain-data", desc: "Historical network metric time-series (activity/ecosystem/financial datasets). Path: /metrics/v2/networks/{slug}/metrics/{dataset}/time-series/{granularity}.", tags: ["crypto", "time-series", "onchain"] },
  "messari-metrics-v1-exchanges-metrics": { name: "Messari Exchange Metrics", subcat: "crypto-blockchain-data", desc: "Market/volume metrics for exchanges.", tags: ["crypto", "exchanges", "market-data"] },
  "messari-metrics-v1-markets-metrics": { name: "Messari Market Metrics", subcat: "crypto-blockchain-data", desc: "Per-market trading metrics.", tags: ["crypto", "markets", "market-data"] },
  "messari-funding-v1-funds": { name: "Messari Funds", subcat: "crypto-blockchain-data", desc: "Crypto VC/funds directory with raise filters.", tags: ["crypto", "funding"] },
  "messari-funding-v1-funds-managers": { name: "Messari Fund Managers", subcat: "crypto-blockchain-data", desc: "Fund manager / investor org directory.", tags: ["crypto", "funding"] },
  "messari-funding-v1-mergers-and-acquisitions": { name: "Messari Mergers & Acquisitions", subcat: "crypto-blockchain-data", desc: "Crypto M&A deal records with amount/date filters.", tags: ["crypto", "funding", "m&a"] },
  "messari-funding-v1-organizations": { name: "Messari Organizations", subcat: "crypto-blockchain-data", desc: "Organizations (projects/investors/companies) directory.", tags: ["crypto", "funding"] },
  "messari-funding-v1-projects": { name: "Messari Projects", subcat: "crypto-blockchain-data", desc: "Crypto projects directory with category/sector/tag filters.", tags: ["crypto", "funding"] },
  "messari-funding-v1-rounds": { name: "Messari Funding Rounds", subcat: "crypto-blockchain-data", desc: "Funding rounds with investor/stage/amount/date filters.", tags: ["crypto", "funding"] },
  "messari-funding-v1-rounds-investors": { name: "Messari Round Investors", subcat: "crypto-blockchain-data", desc: "Investors participating in funding rounds.", tags: ["crypto", "funding"] },
  "messari-signal-v1-assets": { name: "Messari Signal Assets", subcat: "trends-sentiment", desc: "Mindshare (% of crypto-Twitter conversation), sentiment, and post metrics across assets.", tags: ["crypto", "social-signal", "mindshare", "sentiment"] },
  "messari-signal-v1-assets-bitcoin": { name: "Messari Signal Asset (by ID)", subcat: "trends-sentiment", desc: "Mindshare/sentiment/post metrics for a single asset by slug or UUID.", tags: ["crypto", "social-signal", "mindshare"] },
  "messari-signal-v1-assets-mindshare-gainers-24h": { name: "Messari Mindshare Gainers (24h)", subcat: "trends-sentiment", desc: "Assets gaining the most crypto-Twitter mindshare in the last 24h.", tags: ["crypto", "social-signal", "mindshare", "trending"] },
  "messari-signal-v1-assets-mindshare-gainers-7d": { name: "Messari Mindshare Gainers (7d)", subcat: "trends-sentiment", desc: "Assets gaining the most mindshare over 7 days.", tags: ["crypto", "social-signal", "mindshare", "trending"] },
  "messari-signal-v1-assets-mindshare-losers-24h": { name: "Messari Mindshare Losers (24h)", subcat: "trends-sentiment", desc: "Assets losing the most mindshare in 24h.", tags: ["crypto", "social-signal", "mindshare"] },
  "messari-signal-v1-assets-mindshare-losers-7d": { name: "Messari Mindshare Losers (7d)", subcat: "trends-sentiment", desc: "Assets losing the most mindshare over 7 days.", tags: ["crypto", "social-signal", "mindshare"] },
  "messari-signal-v1-assets-time-series-1d": { name: "Messari Signal Time-Series (1d)", subcat: "trends-sentiment", desc: "Historical mindshare/sentiment/post metrics for assets at daily granularity.", tags: ["crypto", "social-signal", "time-series"] },
  "messari-signal-v1-assets-time-series-1h": { name: "Messari Signal Time-Series (1h)", subcat: "trends-sentiment", desc: "Historical mindshare/sentiment/post metrics for assets at hourly granularity.", tags: ["crypto", "social-signal", "time-series"] },
  "messari-signal-v1-x-users": { name: "Messari Signal X Users", subcat: "trends-sentiment", desc: "Mindshare, engagement, and follower data for X/Twitter accounts.", tags: ["crypto", "social-signal", "influencers"] },
  "messari-signal-v1-x-users-time-series-1d": { name: "Messari Signal X Users Time-Series (1d)", subcat: "trends-sentiment", desc: "Historical mindshare/engagement for X accounts at daily granularity.", tags: ["crypto", "social-signal", "time-series"] },
  "messari-news-v1-news-feed": { name: "Messari News Feed", subcat: "news-media", desc: "Curated crypto news feed filtered by asset + source type, with per-article sentiment.", tags: ["crypto", "news", "sentiment"] },
  "messari-token-unlocks-v1-allocations": { name: "Messari Token Allocations", subcat: "crypto-blockchain-data", desc: "Token allocation breakdown (who holds what, vesting progress) for assets.", tags: ["crypto", "token-unlocks", "tokenomics"] },
  "messari-token-unlocks-v1-assets-aptos-events": { name: "Messari Token Unlock Events", subcat: "crypto-blockchain-data", desc: "Upcoming token unlock/vesting events for an asset. Path: /token-unlocks/v1/assets/{slug}/events.", tags: ["crypto", "token-unlocks"] },
  "messari-token-unlocks-v1-assets-aptos-unlocks": { name: "Messari Token Unlock Schedule", subcat: "crypto-blockchain-data", desc: "Token unlock schedule for an asset (requires interval=DAILY/WEEKLY/MONTHLY + startTime/endTime). Path: /token-unlocks/v1/assets/{slug}/unlocks.", tags: ["crypto", "token-unlocks"] },
  "messari-token-unlocks-v1-assets-aptos-vesting-schedule": { name: "Messari Token Vesting Schedule", subcat: "crypto-blockchain-data", desc: "Vesting schedule for an asset (requires interval + startTime/endTime). Path: /token-unlocks/v1/assets/{slug}/vesting-schedule.", tags: ["crypto", "token-unlocks"] },
});

// Remaining names/subcats/tags are derived programmatically (descriptions come from the 402 resource).
function prettify(seg) { return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/24h/i, "(24h)").replace(/7d/i, "(7d)").replace(/\b1d\b/i, "(1d)").replace(/\b1h\b/i, "(1h)"); }

function deriveMeta(group, label, url) {
  if (META[label]) return META[label];
  const path = (() => { try { return new URL(url).pathname; } catch { return label; } })();
  if (group === "messari") {
    const sub = path.includes("/signal/") ? "trends-sentiment" : path.includes("/news/") ? "news-media" : "crypto-blockchain-data";
    const tail = path.replace(/^\/(metrics|signal|news|funding|token-unlocks|ai)\/v\d\//, "").replace(/\//g, " ");
    const fam = path.includes("/signal/") ? "social-signal" : path.includes("/news/") ? "news" : path.includes("/funding/") ? "funding" : path.includes("/token-unlocks/") ? "token-unlocks" : "market-data";
    return { name: "Messari " + prettify(tail), subcat: sub, desc: "", tags: ["crypto", fam, "institutional-data"] };
  }
  return { name: prettify(label), subcat: "crypto-blockchain-data", desc: "", tags: ["crypto"] };
}

async function probe(url, method) {
  const opts = { method, headers: { "User-Agent": UA, Accept: "application/json" } };
  if (method !== "GET") { opts.headers["Content-Type"] = "application/json"; opts.body = "{}"; }
  try {
    const r = await fetch(url, opts);
    const prH = r.headers.get("payment-required");
    const pr = prH ? JSON.parse(Buffer.from(prH, "base64").toString("utf8")) : null;
    return { status: r.status, accepts: pr?.accepts || [], description: pr?.resource?.description || "", bazaar: pr?.extensions?.bazaar || null };
  } catch { return { status: 0, accepts: [], description: "", bazaar: null }; }
}

function outputSample(label) {
  const p = join(ART, `${label}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function outputShape(sample) {
  if (sample == null || typeof sample !== "object") return "body";
  if ("data" in sample) return "body.data";
  if ("url" in sample) return "body.url";
  return "body";
}

// Discover tested endpoints from meta files
const labels = readdirSync(ART).filter((f) => f.endsWith(".meta.json")).map((f) => f.replace(".meta.json", ""));
const byGroup = {};
for (const label of labels) {
  const g = Object.keys(PROVIDERS).find((p) => label.startsWith(p + "-"));
  if (!g) continue;
  (byGroup[g] ||= []).push(label);
}

const entriesBySubcat = {}; // subcat -> [serviceEntry]
const summary = [];

for (const group of Object.keys(byGroup)) {
  const P = PROVIDERS[group];
  for (const label of byGroup[group].sort()) {
    const meta = JSON.parse(readFileSync(join(ART, `${label}.meta.json`), "utf8"));
    const sp = SPEND[label] || {};
    const freeInfo = FREE_MESSARI[label];
    const url = meta.url || sp.url || (freeInfo ? PROVIDERS.messari ? "https://api.messari.io" + freeInfo[0] : null : null);
    if (!url) { console.log(`  ! ${label}: no url, skip`); continue; }
    // free Messari endpoints: synthesize the META entry from FREE_MESSARI so they index cleanly
    if (freeInfo && !META[label]) META[label] = { name: freeInfo[1], subcat: freeInfo[2], desc: freeInfo[3], tags: ["crypto", "reference", "free"] };
    const method = (meta.method || sp.method || "GET").toUpperCase();
    const status = meta.status ?? sp.status;
    const free = meta.classification === "no-402";
    const okPaid = meta.ok && status >= 200 && status < 300;
    if (!free && !okPaid) { console.log(`  ⊘ ${label}: not verified (${meta.classification} ${status}) — skipping`); continue; }
    const dm = deriveMeta(group, label, url);
    const pr = await probe(url, method);
    const cost = free ? 0 : (sp.costUsd ?? meta.costUsd ?? null);
    const sample = outputSample(label);
    const bazaarBody = pr.bazaar?.info?.input?.body;
    const inputExample = method === "GET" ? Object.fromEntries(new URL(url).searchParams) : (bazaarBody || {});
    const desc = dm.desc || pr.description || `${P.provider} ${dm.name} (first-party x402).`;
    const callShape = method === "GET" ? `GET ${url.split("?")[0]} with query params (x402, no key)` : `POST ${url} with JSON body (x402)`;
    const quirks = [P.baseQuirk];
    if (dm.extraQuirk) quirks.push(dm.extraQuirk);
    if (group === "pinata" && label.startsWith("pinata-pin")) quirks.push("fileSize is a QUERY param (?fileSize=bytes), NOT a JSON body (docs say body — wrong). 2-step: pay → presigned URL → POST file as multipart FormData → CID.");
    if (group === "messari" && /\/funding\//.test(url)) quirks.push("Omit the placeholder entity-id filters from examples (managerId/investorId/etc.) — they 400 with 'Invalid ID'. Dates must be RFC3339 (…T00:00:00Z).");

    const backend = {
      url, method, provider: P.provider, providerId: group,
      amount: cost, accepts: pr.accepts || [],
      probe: { status: free ? 200 : 402, method, payable: !free, free, checkedAt: TODAY },
      inputSchema: pr.bazaar?.schema ? { body: pr.bazaar.schema } : null,
      outputSchema: null,
      status: "active",
    };
    const entry = {
      name: dm.name, kind: "api", provider: P.provider, providerId: group,
      aka: [label, slug(dm.name)].filter((v, i, a) => a.indexOf(v) === i),
      description: desc, tags: dm.tags || ["crypto"],
      modality: { input: ["text"], output: ["json"] },
      backends: [backend],
      docs: P.docs,
      usage: {
        status: "verified", verifiedAt: TODAY,
        resultPull: dm.resultPull || "sync", auth: "none",
        callShape, inputExample, outputShape: outputShape(sample),
        quirks, guide: desc + " " + (method === "GET" ? "Call as GET (x402)." : "POST JSON (x402)."),
        costObservedUsd: cost,
      },
      status: "active",
    };
    (entriesBySubcat[dm.subcat] ||= []).push(entry);
    summary.push(`${dm.subcat} ← ${dm.name} (${free ? "free" : "$" + cost})`);
  }
}

// ---- Venice: hidden record (prepaid-only, not per-call) ----
const veniceEntry = {
  name: "Venice (Official x402)", kind: "api", provider: "Venice", providerId: "venice",
  aka: ["venice-official", "venice-x402"],
  description: "Venice's official x402 API (api.venice.ai). NOT INDEXED as a callable service: Venice x402 is a PREPAID-BALANCE model — /x402/top-up deposits USDC into a Venice wallet balance, then inference (/chat/completions, /image/generate, /embeddings, …) draws from that balance via SIWX (X-Sign-In-With-X). There is no pay-per-call x402 endpoint, so it does not fit MasterKey's per-call model.",
  tags: ["llm", "prepaid", "siwx"],
  modality: { input: ["text"], output: ["text"] },
  backends: [{ url: "https://api.venice.ai/api/v1/x402/top-up", method: "POST", provider: "Venice", providerId: "venice", amount: null, accepts: [], probe: { status: 402, method: "POST", payable: false, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "hidden" }],
  docs: "https://docs.venice.ai/guides/integrations/x402-venice-api",
  usage: { status: "broken", verifiedAt: TODAY, resultPull: "none", auth: "siwx", callShape: "POST /x402/top-up (deposit), then SIWX-draw inference", inputExample: {}, outputShape: "n/a", quirks: ["Prepaid-balance model, not pay-per-call. Top-up is a money-mover (deposit into Venice), not a service call."], guide: "Not callable per-request. See droppedReason.", droppedReason: "prepaid-balance model (no per-call x402) — see description", costObservedUsd: 0 },
  status: "hidden", hiddenReason: "prepaid",
};
(entriesBySubcat["llm-chat-apis"] ||= []).push(veniceEntry);
summary.push(`llm-chat-apis ← Venice (Official x402) [HIDDEN: prepaid]`);

// ---- Merge into curation/<subcat>.json (replace by slug(name)) ----
const affected = new Set();
for (const [subcat, entries] of Object.entries(entriesBySubcat)) {
  const path = join(CURATION, subcat + ".json");
  if (!existsSync(path)) { console.log(`  ! curation/${subcat}.json missing — creating`); }
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { subcategory: subcat, category: "data-intelligence", unit: "per call", entries: [] };
  const existing = file.entries || [];
  const bySlugName = new Map(existing.map((e) => [slug(e.name), e]));
  let added = 0, replaced = 0;
  for (const e of entries) {
    const k = slug(e.name);
    if (bySlugName.has(k)) { const i = existing.indexOf(bySlugName.get(k)); existing[i] = e; replaced++; }
    else { existing.push(e); added++; }
  }
  file.entries = existing;
  if (!DRY) writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  affected.add(subcat);
  console.log(`  ${subcat}: +${added} new, ~${replaced} replaced (now ${existing.length})`);
}

console.log("\n--- summary ---");
summary.forEach((s) => console.log("  " + s));
console.log(`\nAffected subcats: ${[...affected].join(" ")}`);
console.log(`\nNext: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
