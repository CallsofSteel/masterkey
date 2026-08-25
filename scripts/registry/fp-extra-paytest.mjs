/**
 * fp-extra-paytest.mjs — pay-test the remaining FIRST-PARTY x402 gaps the user asked for:
 * messari (1: AI chat), allium (10: tokens/prices/wallet), zerion (3: fungibles-by-impl/nfts/dapps).
 * Own-host endpoints → firstParty (stamped by curate from first-party.json), NOT Sponge.
 * Money-safe via qa-pay (cap=$1 + $4 sprint backstop). Idempotent. Run: node scripts/registry/fp-extra-paytest.mjs [--dry]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/fp-extra");
mkdirSync(ART, { recursive: true });
const DRY = process.argv.includes("--dry");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// [method, url, body|null, queryString|null, label]
const T = [
  ["POST", "https://api.messari.io/ai/v2/chat/completions", { messages: [{ role: "user", content: "What is Bitcoin? Answer in one sentence." }], stream: false, response_format: "markdown" }, null, "messari-ai-chat-completions"],
  // allium
  ["GET", "https://agents.allium.so/api/v1/developer/tokens", null, null, "allium-tokens"],
  ["GET", "https://agents.allium.so/api/v1/developer/tokens/search", null, "q=USDC", "allium-tokens-search"],
  ["POST", "https://agents.allium.so/api/v1/developer/tokens/chain-address", [{ token_address: WETH, chain: "ethereum" }], null, "allium-tokens-chain-address"],
  ["POST", "https://agents.allium.so/api/v1/developer/prices", [{ token_address: WETH, chain: "ethereum" }], null, "allium-prices"],
  ["POST", "https://agents.allium.so/api/v1/developer/prices/stats", [{ token_address: WETH, chain: "ethereum" }], null, "allium-prices-stats"],
  ["POST", "https://agents.allium.so/api/v1/developer/prices/history", { addresses: [{ token_address: WETH, chain: "ethereum" }], start_timestamp: 1735689600, end_timestamp: 1738368000, time_granularity: "1d" }, null, "allium-prices-history"],
  ["POST", "https://agents.allium.so/api/v1/developer/prices/at-timestamp", { addresses: [{ token_address: WETH, chain: "ethereum" }], timestamp: 1735689600, time_granularity: "1d" }, null, "allium-prices-at-timestamp"],
  ["POST", "https://agents.allium.so/api/v1/developer/wallet/balances", [{ chain: "ethereum", address: VITALIK }], null, "allium-wallet-balances"],
  ["POST", "https://agents.allium.so/api/v1/developer/wallet/balances/history", { addresses: [{ chain: "ethereum", address: VITALIK }], start_timestamp: 1735689600, end_timestamp: 1738368000 }, null, "allium-wallet-balances-history"],
  ["POST", "https://agents.allium.so/api/v1/developer/wallet/pnl", [{ chain: "ethereum", address: VITALIK }], null, "allium-wallet-pnl"],
  // zerion
  ["GET", "https://api.zerion.io/v1/dapps", null, "page[size]=5", "zerion-dapps"],
];

function pay({ method, url, body, label }) {
  const meta = join(ART, `${label}.meta.json`), artifact = join(ART, `${label}.json`);
  if (existsSync(meta)) { const p = JSON.parse(readFileSync(meta, "utf8")); if (p.ok) { console.log(`  · skip (done): ${label}`); return p; } }
  const args = [join(ROOT, "scripts/registry/dist/qa-pay.mjs"), `--url=${url}`, `--method=${method}`, `--cap=1`, `--save=${artifact}`, `--label=${label}`];
  if (body != null) args.push(`--body=${JSON.stringify(body)}`);
  if (DRY) { console.log(`  DRY ${label}: ${method} ${url}${body ? " " + JSON.stringify(body).slice(0, 80) : ""}`); return null; }
  let line;
  try { const out = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, QA_SPRINT_CEILING: "4", QA_SPRINT_PREFIX: "allium-,messari-,zerion-" } }); line = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); }
  catch (e) { line = { label, classification: "exception", ok: false, error: String(e.message || e).slice(0, 160) }; }
  writeFileSync(meta, JSON.stringify({ ...line, url, method, label }, null, 2));
  console.log(`  ${line.ok ? "✓" : "✗"} ${label}: ${line.classification}${line.costUsd != null ? " $" + line.costUsd : ""}${line.status ? " [" + line.status + "]" : ""}${line.error ? " " + String(line.error).slice(0, 80) : ""}`);
  return line;
}

console.log(`\n=== fp-extra-paytest: ${T.length} endpoints cap=$1 ${DRY ? "(DRY)" : ""} ===`);
for (const [method, base, body, qs, label] of T) {
  const url = qs ? base + "?" + qs : base;
  pay({ method, url, body, label });
}
