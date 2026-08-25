/**
 * sponge-scope.mjs — FREE liveness/price scope for the Sponge-provided + first-party x402 indexing task.
 *
 * Enumerates billable candidate endpoints from the agentic-market config (the structured source behind
 * agentic.market), de-dupes against our live registry, then FREE-probes each (unpaid) to learn: is it a
 * live x402 402? real price + networks (from the decoded payment-required `accepts`)? bazaar input shape?
 * NO money is spent here. Writes a manifest the paid runner consumes.
 *
 * Usage: node scripts/registry/sponge-scope.mjs --bucket=sponge|fp|all [--cap=3] [--conc=8]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const CONFIG = "./config/services.json";
const REG = join(ROOT, "data/registry/by-subcat");
const ART = join(ROOT, "data/registry/qa-artifacts/sponge-fp");
mkdirSync(ART, { recursive: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const BUCKET = arg("bucket", "sponge");
const CAP = parseFloat(arg("cap", "3"));
const CONC = parseInt(arg("conc", "8"), 10);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const SPONGE = new Set(["perplexity", "deepgram", "rentcast", "screenshotone", "wolframalpha", "fal", "spyfu", "freepik", "tripadvisor", "2captcha", "e2b", "sponge"]);
const norm = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/$/, "").toLowerCase(); } catch { return (u || "").toLowerCase(); } };

// existing registry backend URLs
const have = new Set();
for (const f of readdirSync(REG)) for (const s of JSON.parse(readFileSync(join(REG, f), "utf8"))) for (const b of s.backends || []) if (b.url) have.add(norm(b.url));

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const services = Array.isArray(cfg) ? cfg : (cfg.services || Object.values(cfg));
const billable = (e) => e.pricing && e.pricing.amount != null;
const inBucket = (s) => BUCKET === "all" ? true : BUCKET === "sponge" ? SPONGE.has(s.id) : (s.integration_type === "1P" && !SPONGE.has(s.id));

// candidate list
const cands = [];
for (const s of services) {
  if (!inBucket(s)) continue;
  for (const e of s.endpoints || []) {
    if (!billable(e)) continue;
    if (BUCKET === "sponge" && !/paysponge\.com/i.test(e.url)) continue;
    const n = norm(e.url);
    if (have.has(n)) continue; // already indexed
    if (/\{[^}]+\}/.test(e.url)) continue; // unresolved path template — needs an id; handle in paid flow, skip blind probe
    cands.push({ svc: s.id, provider: s.name, integration: s.integration_type, url: e.url, method: (e.method || "POST").toUpperCase(), advPrice: parseFloat(e.pricing.amount) || 0, advNets: e.supported_networks || [], desc: e.description || "" });
  }
}

function decodePR(h) { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } }
async function probe(c) {
  const opts = { method: c.method, headers: { "User-Agent": UA, Accept: "application/json" } };
  if (c.method !== "GET") { opts.headers["Content-Type"] = "application/json"; opts.body = "{}"; }
  const ctl = AbortSignal.timeout(15000);
  let r;
  try { r = await fetch(c.url, { ...opts, signal: ctl }); } catch (e) { return { ...c, status: 0, verdict: "dead", err: String(e.name || e).slice(0, 40) }; }
  const prH = r.headers.get("payment-required") || r.headers.get("x-payment-required");
  const pr = prH ? decodePR(prH) : null;
  const accepts = pr?.accepts || [];
  const nets = [...new Set(accepts.map((a) => a.network).filter(Boolean))];
  const x402 = (pr?.protocols || accepts.length) ? true : (r.status === 402);
  // real price from accepts (max amount / token decimals) — fall back to advertised
  let realPrice = null;
  for (const a of accepts) {
    const dec = a.asset?.decimals ?? (a.extra?.decimals) ?? 6;
    const raw = a.maxAmountRequired ?? a.amount;
    if (raw != null) { const v = Number(raw) / 10 ** dec; if (realPrice == null || v > realPrice) realPrice = v; }
  }
  let verdict;
  if (r.status === 402 && x402) verdict = "x402";
  else if (r.status >= 200 && r.status < 300) verdict = "free-2xx";
  else if (r.status === 402) verdict = "402-nonx402";
  else verdict = "no-402";
  return { ...c, status: r.status, verdict, x402, realPrice: realPrice ?? c.advPrice, nets: nets.length ? nets : c.advNets, hasBazaar: !!pr?.extensions?.bazaar };
}

// bounded concurrency
async function run() {
  const out = [];
  let i = 0;
  async function worker() { while (i < cands.length) { const c = cands[i++]; out.push(await probe(c)); if (out.length % 25 === 0) process.stderr.write(`  probed ${out.length}/${cands.length}\n`); } }
  await Promise.all(Array.from({ length: Math.min(CONC, cands.length) }, worker));
  return out;
}

const res = await run();
const manifest = join(ART, `manifest-${BUCKET}.json`);
writeFileSync(manifest, JSON.stringify(res, null, 2));

const x402 = res.filter((r) => r.verdict === "x402");
const free = res.filter((r) => r.verdict === "free-2xx");
const dead = res.filter((r) => r.verdict === "dead" || r.verdict === "no-402" || r.verdict === "402-nonx402");
const payable = x402.filter((r) => r.realPrice <= CAP);
const overcap = x402.filter((r) => r.realPrice > CAP);
const baseOk = (r) => (r.nets || []).some((n) => /base/i.test(n));
const cost = payable.reduce((a, r) => a + (r.realPrice || 0), 0);

console.log(`\n===== SCOPE bucket=${BUCKET} cap=$${CAP} =====`);
console.log(`candidates (missing, billable, no-template): ${cands.length}`);
console.log(`  live x402:      ${x402.length}  (Base-payable: ${x402.filter(baseOk).length})`);
console.log(`  free 2xx:       ${free.length}`);
console.log(`  dead/no-402:    ${dead.length}`);
console.log(`  within cap ($${CAP}): ${payable.length}  → est pay cost: $${cost.toFixed(2)}`);
console.log(`  OVER CAP (>$${CAP}): ${overcap.length}  [${overcap.map((r) => r.svc + " $" + r.realPrice).join(", ") || "none"}]`);
const byS = {};
for (const r of x402) (byS[r.svc] ??= []).push(r);
console.log(`\nper-provider (live x402):`);
for (const [svc, rs] of Object.entries(byS).sort((a, b) => b[1].length - a[1].length)) {
  const c = rs.reduce((a, r) => a + (r.realPrice || 0), 0);
  console.log(`  ${svc.padEnd(16)} ${String(rs.length).padStart(3)} x402  $${c.toFixed(2).padStart(7)}  nets:[${[...new Set(rs.flatMap((r) => r.nets))].join(",")}]`);
}
console.log(`\nmanifest: ${manifest}`);
