/**
 * fix-accepts.mjs — targeted accepts backfill for the pre-existing served-but-unpayable backends that
 * enrich-accepts-durable missed (false-positive template skip on `:generateContent`/`/AAPL`, or accepts
 * carried in the 402 BODY). Probes live (header AND body), writes accepts to the manual backend in
 * curation. Allium async poll-legs copy accepts from their sibling. Endpoints with no decodable accepts
 * are hidden (needs-review). FREE probing only — no payment. Then run curate on the affected subcats.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CUR = join(__dir, "curation");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const NOW = new Date().toISOString();

function extractAccepts(pr, body) {
  const norm = (a) => Array.isArray(a) && a.length && a.every((x) => (x.amount ?? x.maxAmountRequired) && x.asset && x.network)
    ? a.map((x) => ({ scheme: x.scheme || "exact", network: x.network, asset: x.asset, amount: String(x.amount ?? x.maxAmountRequired), payTo: x.payTo, maxTimeoutSeconds: x.maxTimeoutSeconds, ...(x.extra ? { extra: x.extra } : {}) })) : null;
  return norm(pr?.accepts) || norm(pr?.paymentRequirements) || norm(body?.accepts) || norm(body?.paymentRequirements) || norm(body?.data?.accepts) || null;
}
async function probe(url, method, probeBody) {
  const o = { method, headers: { "User-Agent": UA, Accept: "application/json" }, redirect: "manual" };
  if (method !== "GET") { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(probeBody || {}); }
  const r = await fetch(url, { ...o, signal: AbortSignal.timeout(20000) });
  const h = r.headers.get("payment-required");
  let pr = null; if (h) { try { pr = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
  let body = null; try { body = JSON.parse(await r.text()); } catch {}
  return { status: r.status, accepts: extractAccepts(pr, body) };
}

// targets: probe-and-fill manual backends (match by url prefix within the service)
const FILL = [
  ["image-generation", "Nano Banana Pro Generate", "https://x402.orth.sh/nano-banana"],
  ["image-generation", "Nano Banana (Gemini 2.5 Flash) Generate", "https://x402.orth.sh/nano-banana"],
  ["stocks-financial-data", "BlockRun US Stock Spot Price", "https://blockrun.ai/api/v1/usstock/price/"],
  ["stocks-financial-data", "BlockRun US Stock Spot Price", "https://blockrun.ai/api/v1/stocks/us/price/"],
  ["headless-browsers", "StableBrowser Session (browser automation)", "https://stablebrowser.dev/api/sessions"],
];
// copy accepts from a sibling backend (same service) for templated poll-legs
const COPY = [
  ["crypto-blockchain-data", "Allium Explorer SQL Query"], // fill any empty backend from a sibling that has accepts
  ["headless-browsers", "StableBrowser Session (browser automation)"], // stablebrowser.dev 307-redirects; copy from www/vercel sibling
];
// hide (needs-review) services whose 402 carries no decodable accepts (can't pay cleanly)
const HIDE = [
  ["ai-semantic-search", "Honcho Agent Memory", "402 returns no decodable accepts (non-standard challenge) — can't route payment"],
  ["storefront-commerce-apis", "StableFlowers", "402 returns no decodable accepts — can't route payment (browse may be free; re-curate if so)"],
];

const touched = new Set();
function loadCur(sub) { return JSON.parse(readFileSync(join(CUR, sub + ".json"), "utf8")); }
function saveCur(sub, c) { writeFileSync(join(CUR, sub + ".json"), JSON.stringify(c, null, 2) + "\n"); touched.add(sub); }

for (const [sub, name, prefix] of FILL) {
  const c = loadCur(sub); const e = c.entries.find((x) => x.name === name); if (!e) { console.log(`! ${name}: not found`); continue; }
  const b = (e.backends || []).find((x) => typeof x === "object" && (x.url || "").startsWith(prefix) && !(x.accepts || []).length);
  if (!b) { console.log(`= ${name} ${prefix}: already filled / not found`); continue; }
  const r = await probe(b.url, b.method || "POST", b.modelParam ? { [b.modelParam.name]: b.modelParam.value } : {});
  if (r.accepts) { b.accepts = r.accepts; b.probe = { ...(b.probe || {}), status: 402, payable: true, checkedAt: NOW }; saveCur(sub, c); console.log(`✓ ${name}: filled ${r.accepts.length} accept(s) [${r.accepts.map((a) => a.network).join(",")}]`); }
  else console.log(`✗ ${name} ${prefix}: probe ${r.status}, no accepts`);
}

for (const [sub, name] of COPY) {
  const c = loadCur(sub); const e = c.entries.find((x) => x.name === name); if (!e) continue;
  const donor = (e.backends || []).find((x) => typeof x === "object" && (x.accepts || []).length);
  if (!donor) { console.log(`! ${name}: no sibling with accepts to copy`); continue; }
  let n = 0;
  for (const b of e.backends || []) if (typeof b === "object" && !(b.accepts || []).length) { b.accepts = donor.accepts; b.probe = { ...(b.probe || {}), status: 402, payable: true, checkedAt: NOW }; n++; }
  if (n) { saveCur(sub, c); console.log(`✓ ${name}: copied accepts to ${n} poll-leg backend(s) from sibling`); }
}

for (const [sub, name, reason] of HIDE) {
  const c = loadCur(sub); const e = c.entries.find((x) => x.name === name); if (!e) { console.log(`! ${name}: not found`); continue; }
  e.status = "hidden"; e.hiddenReason = "needs-review";
  e.usage = { ...(e.usage || {}), status: "untested", droppedReason: reason };
  saveCur(sub, c); console.log(`· ${name}: hidden (needs-review) — ${reason}`);
}

console.log(`\ntouched subcats: ${[...touched].join(" ")}`);
console.log(`next: ${[...touched].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
