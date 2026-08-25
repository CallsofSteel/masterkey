/**
 * apify-enrich.mjs — for a list of Apify actorIds, fetch (free) the live actor object + latest build
 * to capture REAL current pricing (the static actors-file pricingModel is unreliable) and the input
 * schema (properties/required/prefill). Emits a compact enriched record per actor that add-apify.mjs
 * turns into registry entries.
 *
 * Reads  /tmp/apify-top50.json (array of actor records w/ actorId, title, description, categories, runUrl, totalUsers)
 * Writes /tmp/apify-enriched.json
 *
 * Usage: node scripts/registry/apify-enrich.mjs
 */
import * as fs from "node:fs";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const IN = arg("in", "/tmp/apify-top50.json");
const OUT = arg("out", "/tmp/apify-enriched.json");
const actors = JSON.parse(fs.readFileSync(IN, "utf8"));
const BASE = "https://api.apify.com/v2/acts";

const getJson = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return { _httpError: r.status };
  return r.json();
};

// Probe the run URL with NO payment → the x402 402 carries `accepts` (BOTH `exact` and `upto` schemes,
// max $1.00 USDC on Base). Captured at index time so the registry needs no accepts backfill. Free (402
// precedes the run). Normalizes to the registry accepts shape.
async function probeAccepts(runUrl) {
  try {
    const u = runUrl + (runUrl.includes("?") ? "&" : "?") + "maxTotalChargeUsd=0.50";
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json", accept: "application/json" }, body: "{}" });
    const h = r.headers.get("payment-required"); let pr = null; if (h) { try { pr = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
    let body = null; try { body = JSON.parse(await r.text()); } catch {}
    const raw = pr?.accepts || body?.accepts || [];
    return raw.filter((a) => a.network && a.asset && (a.maxAmountRequired ?? a.amount))
      .map((a) => ({ scheme: a.scheme || "exact", network: a.network, asset: a.asset, amount: String(a.maxAmountRequired ?? a.amount), payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, ...(a.extra ? { extra: a.extra } : {}) }));
  } catch { return []; }
}

// current pricing = the pricingInfos entry with the latest startedAt
function currentPricing(infos) {
  if (!Array.isArray(infos) || !infos.length) return null;
  const sorted = [...infos].sort((a, b) => new Date(a.startedAt || a.createdAt || 0) - new Date(b.startedAt || b.createdAt || 0));
  const cur = sorted[sorted.length - 1];
  const model = cur.pricingModel;
  let unitPrice = cur.pricePerUnitUsd;
  if (cur.tieredPricing && cur.tieredPricing.FREE) unitPrice = cur.tieredPricing.FREE.tieredPricePerUnitUsd;
  // PAY_PER_EVENT carries an events map
  let events = null;
  if (model === "PAY_PER_EVENT" && cur.pricingPerEvent && cur.pricingPerEvent.actorChargeEvents) {
    events = Object.entries(cur.pricingPerEvent.actorChargeEvents).map(([k, v]) => ({
      event: k, title: v.eventTitle, priceUsd: v.eventPriceUsd,
    }));
  }
  return { model, unitName: cur.unitName, unitPriceUsd: unitPrice, events };
}

// build a minimal valid input example from the schema prefills
function buildExample(schema) {
  if (!schema || !schema.properties) return {};
  const props = schema.properties;
  const req = Array.isArray(schema.required) ? schema.required : [];
  const ex = {};
  const take = (k) => {
    const p = props[k]; if (!p) return;
    const v = p.prefill !== undefined ? p.prefill : (p.default !== undefined ? p.default : undefined);
    if (v !== undefined) ex[k] = v;
  };
  // always include required fields; if none, include the first few prefilled props (the actor's own example)
  if (req.length) req.forEach(take);
  else Object.keys(props).filter((k) => props[k].prefill !== undefined).slice(0, 4).forEach(take);
  return ex;
}

const out = [];
let i = 0;
const CONC = 6;
async function worker() {
  while (i < actors.length) {
    const a = actors[i++];
    try {
      const act = (await getJson(`${BASE}/${a.actorId}`)).data;
      if (!act) { out.push({ ...a, _err: "no act" }); continue; }
      const buildId = act.taggedBuilds?.latest?.buildId;
      let schema = null, readme = act.readmeSummary || "";
      if (buildId) {
        const build = (await getJson(`${BASE}/${a.actorId}/builds/${buildId}`)).data;
        if (build?.inputSchema) { try { schema = typeof build.inputSchema === "string" ? JSON.parse(build.inputSchema) : build.inputSchema; } catch {} }
      }
      const pricing = currentPricing(act.pricingInfos);
      const example = buildExample(schema);
      const accepts = a.runUrl ? await probeAccepts(a.runUrl) : [];
      out.push({
        accepts, // [{scheme:exact|upto, network, asset, amount, payTo}] — captured at index time
        actorId: a.actorId, slug: a.slug, title: act.title || a.title,
        description: (act.description || a.description || "").slice(0, 300),
        categories: act.categories || a.categories || [],
        totalUsers: a.totalUsers, runUrl: a.runUrl, storeUrl: a.storeUrl,
        permissionLevel: act.actorPermissionLevel,
        pricing, // {model, unitName, unitPriceUsd, events}
        required: schema?.required || [],
        propKeys: schema?.properties ? Object.keys(schema.properties) : [],
        inputExample: example,
        readmeSummary: readme.slice(0, 400),
      });
      process.stdout.write(".");
    } catch (e) { out.push({ ...a, _err: String(e).slice(0, 80) }); process.stdout.write("x"); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nenriched ${out.length} actors -> ${OUT}  (with-accepts: ${out.filter((o) => (o.accepts || []).length).length})`);
// quick pricing-model tally (shows how wrong the static PAY_PER_EVENT label was)
const tally = {};
for (const o of out) { const m = o.pricing?.model || "unknown"; tally[m] = (tally[m] || 0) + 1; }
console.log("LIVE pricing models:", JSON.stringify(tally));
