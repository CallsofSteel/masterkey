/**
 * add-fp-extra.mjs — fold the messari/allium/zerion gap endpoints pay-tested in fp-extra-paytest.mjs
 * into curation. FIRST-PARTY own-host endpoints → curate stamps firstParty from first-party.json (NOT Sponge).
 * Recover-aware: big-JSON 200s land as "exception" in the runner meta; we trust artifact + spend-log status.
 * Run: node scripts/registry/add-fp-extra.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/fp-extra");
const CURATION = join(__dir, "curation");
const SUBCAT = "crypto-blockchain-data";
const DRY = process.argv.includes("--dry");
const TODAY = "2026-06-18";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const SPEND = {};
for (const l of readFileSync(join(ROOT, "data/registry/qa-spend-log.jsonl"), "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.label) SPEND[j.label] = j; } catch {} }

const BRAND = { messari: ["Messari", "https://docs.messari.io/api-reference/x402-payments"], allium: ["Allium", "https://docs.allium.so/ai/x402/api-reference"], zerion: ["Zerion", "https://developers.zerion.io/build-with-ai/x402"] };
const Q = { messari: "First-party Messari x402 (no API key). Base/Solana USDC.", allium: "First-party Allium x402 (no API key). POST endpoints take JSON; many take an addresses[] array of {chain, token_address|address}. Base/Solana USDC.", zerion: "First-party Zerion x402 ($0.01/call, no API key). GET the standard Zerion REST endpoint WITHOUT a trailing slash. Base/Solana USDC." };

// label -> [group, name, desc, tags[], method, inputExample, resultPull?, extraQuirk?]
const V = {
  "messari-ai-chat-completions": ["messari", "Messari AI Chat", "Crypto research chat (Messari AI) — ask a question, get a cited markdown answer.", ["crypto", "ai-chat", "research"], "POST", { messages: [{ role: "user", content: "What is Bitcoin? Answer in one sentence." }], stream: false, response_format: "markdown" }],
  "allium-tokens": ["allium", "Allium Tokens", "List/browse tokens tracked by Allium across chains.", ["crypto", "tokens", "onchain"], "GET", {}],
  "allium-tokens-search": ["allium", "Allium Token Search", "Search tokens by name or symbol.", ["crypto", "tokens", "search"], "GET", { q: "USDC" }],
  "allium-tokens-chain-address": ["allium", "Allium Token by Chain & Address", "Resolve token metadata by chain + contract address.", ["crypto", "tokens", "onchain"], "POST", [{ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", chain: "ethereum" }]],
  "allium-prices": ["allium", "Allium Token Prices", "Current USD prices for tokens by chain + contract address.", ["crypto", "prices", "market-data"], "POST", [{ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", chain: "ethereum" }]],
  "allium-prices-stats": ["allium", "Allium Price Stats", "Price statistics (change/volume) for tokens.", ["crypto", "prices", "market-data"], "POST", [{ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", chain: "ethereum" }]],
  "allium-prices-history": ["allium", "Allium Price History", "Historical token prices over a time range.", ["crypto", "prices", "time-series"], "POST", { addresses: [{ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", chain: "ethereum" }], start_timestamp: 1735689600, end_timestamp: 1738368000, time_granularity: "1d" }, "sync", "Body is an OBJECT: { addresses:[{token_address,chain}], start_timestamp, end_timestamp, time_granularity } — time_granularity is REQUIRED."],
  "allium-prices-at-timestamp": ["allium", "Allium Price at Timestamp", "Token price at a specific unix timestamp.", ["crypto", "prices"], "POST", { addresses: [{ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", chain: "ethereum" }], timestamp: 1735689600, time_granularity: "1d" }, "sync", "Body: { addresses:[{token_address,chain}], timestamp, time_granularity (required) }."],
  "allium-wallet-balances": ["allium", "Allium Wallet Balances", "Current token balances for a wallet across chains.", ["crypto", "wallet-analytics", "onchain"], "POST", [{ chain: "ethereum", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }]],
  "allium-wallet-balances-history": ["allium", "Allium Wallet Balance History", "Historical wallet balances over a time range.", ["crypto", "wallet-analytics", "time-series"], "POST", { addresses: [{ chain: "ethereum", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }], start_timestamp: 1735689600, end_timestamp: 1738368000 }, "sync", "Body is an OBJECT: { addresses:[{chain,address}], start_timestamp, end_timestamp }."],
  "zerion-dapps": ["zerion", "Zerion Dapps", "List of dApps tracked by Zerion with metadata.", ["crypto", "dapps", "reference"], "GET", { "page[size]": "5" }],
};

// parked (hidden track-record)
const PARK = {
  "allium-wallet-pnl": ["allium", "Allium Wallet PnL", SUBCAT, ["crypto", "wallet-analytics", "pnl"], "POST", "needs-review", "Persistent 500 Internal Server Error on a valid list body — server-side. Re-test later.", [{ chain: "ethereum", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }], "https://agents.allium.so/api/v1/developer/wallet/pnl", "POST"],
  "zerion-fungibles-by-implementation": ["zerion", "Zerion Fungible by Implementation", SUBCAT, ["crypto", "tokens"], "GET", "needs-input", "Requires a correctly-formatted filter[implementation_chain_id]/filter[implementation_address] pair we couldn't satisfy (400 'Malformed parameter'). Determine the exact chain-id format before paying.", {}, "https://api.zerion.io/v1/fungibles/by-implementation", "GET"],
  "zerion-nfts": ["zerion", "Zerion NFTs", SUBCAT, ["crypto", "nft"], "GET", "needs-input", "filter[references] is a mandatory parameter (format undetermined) — 400 without it.", {}, "https://api.zerion.io/v1/nfts", "GET"],
};

async function probeAccepts(url, method) {
  const opts = { method, headers: { "User-Agent": UA, Accept: "application/json" } };
  if (method !== "GET") { opts.headers["Content-Type"] = "application/json"; opts.body = "{}"; }
  try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); const h = r.headers.get("payment-required"); const pr = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; return pr?.accepts || []; } catch { return []; }
}
function verifiedStatus(label) {
  const sp = SPEND[label] || {}; const meta = existsSync(join(ART, `${label}.meta.json`)) ? JSON.parse(readFileSync(join(ART, `${label}.meta.json`), "utf8")) : {};
  const status = sp.status ?? meta.status; const ok = (meta.ok === true) || (status >= 200 && status < 300);
  return { ok, status, cost: sp.costUsd ?? meta.costUsd ?? null, url: sp.url ?? meta.url, method: sp.method ?? meta.method };
}
function outShape(label) { const p = join(ART, `${label}.json`); if (!existsSync(p)) return "body"; try { const j = JSON.parse(readFileSync(p, "utf8")); if (Array.isArray(j)) return "body (array)"; if (j && typeof j === "object") { if ("items" in j) return "body.items"; if ("data" in j) return "body.data"; } } catch {} return "body"; }

const entries = [];
const summary = [];
for (const [label, def] of Object.entries(V)) {
  const [group, name, desc, tags, method, inputExample, resultPull, quirk] = def;
  const vs = verifiedStatus(label);
  if (!vs.ok || !vs.url) { console.log(`  ⊘ ${label}: not verified (status ${vs.status}) — skipping`); continue; }
  const [brand, docs] = BRAND[group];
  const accepts = await probeAccepts(vs.url, method);
  const quirks = [Q[group]]; if (quirk) quirks.push(quirk);
  const callShape = method === "GET" ? `GET ${vs.url.split("?")[0]} with query params (x402)` : `POST ${vs.url} with JSON body (x402)`;
  const backend = { url: vs.url, method, provider: brand, providerId: slug(brand), amount: vs.cost, accepts, probe: { status: 402, method, payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "active" };
  entries.push({ name, kind: "api", provider: brand, providerId: slug(brand), aka: [label, slug(name)].filter((v, i, a) => a.indexOf(v) === i), description: desc, tags, modality: { input: ["text"], output: ["json"] }, backends: [backend], docs, usage: { status: "verified", verifiedAt: TODAY, resultPull: resultPull || "sync", auth: "none", callShape, inputExample, outputShape: outShape(label), quirks, guide: `${desc} ${Q[group]}`, costObservedUsd: vs.cost }, status: "active" });
  summary.push(`✓ ${name} ($${vs.cost})`);
}
// parked
for (const [label, def] of Object.entries(PARK)) {
  const [group, name, , tags, method, reason, note, inputExample, url] = def;
  const [brand, docs] = BRAND[group];
  entries.push({ name, kind: "api", provider: brand, providerId: slug(brand), aka: [label, slug(name)].filter((v, i, a) => a.indexOf(v) === i), description: `${name} (first-party ${brand} x402). Parked: ${note}`, tags, modality: { input: ["text"], output: ["json"] }, backends: [{ url, method, provider: brand, providerId: slug(brand), amount: null, accepts: await probeAccepts(url, method), probe: { status: 402, method, payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, status: "hidden" }], docs, usage: { status: "untested", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: `${method} ${url}`, inputExample, outputShape: "body", quirks: [Q[group], note], guide: note, droppedReason: note, costObservedUsd: 0 }, status: "hidden", hiddenReason: reason });
  summary.push(`· ${name} [hidden: ${reason}]`);
}

const path = join(CURATION, SUBCAT + ".json");
const file = JSON.parse(readFileSync(path, "utf8"));
const bySlugName = new Map(file.entries.map((e) => [slug(e.name), e]));
let added = 0, replaced = 0;
for (const e of entries) { const k = slug(e.name); if (bySlugName.has(k)) { file.entries[file.entries.indexOf(bySlugName.get(k))] = e; replaced++; } else { file.entries.push(e); added++; } }
if (!DRY) writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
console.log(`\n  ${SUBCAT}: +${added} new, ~${replaced} replaced (now ${file.entries.length})`);
summary.forEach((s) => console.log("  " + s));
console.log(`\nNext: node scripts/registry/curate.mjs --subcat=${SUBCAT}`);
