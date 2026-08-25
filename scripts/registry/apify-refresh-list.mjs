/**
 * apify-refresh-list.mjs — refresh the dynamic Apify provider's local data (NOT the registry).
 * Re-pulls the live Apify Store (allowsAgenticUsers=true) → data/apify/actors.json (the search index)
 * and re-probes one actor's 402 → data/apify/meta.json (the shared exact+upto accepts).
 * Apify actors are resolved dynamically (src/lib/apify.ts) so this is the only thing to keep fresh.
 *
 * Usage: node scripts/registry/apify-refresh-list.mjs [--pages=400]   (50 actors/page)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/apify");
mkdirSync(OUT, { recursive: true });
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const PAGES = parseInt(arg("pages", "400"), 10); // 400 * 50 = 20k cap
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const list = [];
const seen = new Set();
for (let p = 0; p < PAGES; p++) {
  let j;
  try { j = await (await fetch(`https://api.apify.com/v2/store?allowsAgenticUsers=true&limit=50&offset=${p * 50}&sortBy=popularity`, { headers: { "User-Agent": UA, accept: "application/json" } })).json(); }
  catch (e) { console.error("page", p, "error", String(e).slice(0, 60)); break; }
  const items = j?.data?.items || [];
  if (!items.length) break;
  for (const it of items) {
    const actorId = `${it.username}~${it.name}`;
    if (seen.has(actorId)) continue; seen.add(actorId);
    list.push({ actorId, author: it.username, title: it.title || it.name, categories: it.categories || [], totalUsers: it.stats?.totalUsers || it.totalUsers || 0, runUrl: `https://api.apify.com/v2/actors/${actorId}/run-sync-get-dataset-items` });
  }
  if (p % 20 === 0) process.stderr.write(`  page ${p} (${list.length})\n`);
}
list.sort((a, b) => b.totalUsers - a.totalUsers);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT, "actors.json"), JSON.stringify({ source: "Apify Store allowsAgenticUsers=true", fetchedAt: today, count: list.length, actors: list }));
console.log(`actors.json: ${list.length} actors`);

// refresh accepts (exact + upto) from a live 402 on a stable actor
try {
  const r = await fetch("https://api.apify.com/v2/actors/apify~instagram-scraper/run-sync-get-dataset-items?maxTotalChargeUsd=0.50", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", accept: "application/json" }, body: "{}" });
  const h = r.headers.get("payment-required"); let pr = null; if (h) { try { pr = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
  let body = null; try { body = JSON.parse(await r.text()); } catch {}
  const raw = pr?.accepts || body?.accepts || [];
  const accepts = raw.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset, amount: String(a.maxAmountRequired ?? a.amount), payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, ...(a.extra ? { extra: a.extra } : {}) }));
  if (accepts.length) { writeFileSync(join(OUT, "meta.json"), JSON.stringify({ fetchedAt: today, runEndpoint: "run-sync-get-dataset-items", base: "https://api.apify.com/v2/actors", accepts }, null, 1)); console.log(`meta.json: accepts ${accepts.map((a) => a.scheme).join("+")} payTo ${accepts[0]?.payTo}`); }
} catch (e) { console.error("accepts refresh failed:", String(e).slice(0, 60)); }
