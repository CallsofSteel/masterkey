/**
 * set-accepts.mjs — write a probed payment.accepts[] to the SOURCE for ONE backend url, durably.
 * Finds the backend in curation/<sub>.json (manual object) or candidates/<sub>.json (ref by url) and
 * sets its `accepts`. Touches ONLY accepts (+ a probe stamp). Run curate.mjs afterwards.
 *
 * Usage:
 *   node scripts/registry/set-accepts.mjs --subcat=web-analytics --url='https://...' --accepts=@/tmp/a.json
 *   (accepts file = a JSON array of {scheme,network,asset,amount,payTo?})
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sub = arg("subcat"), url = arg("url"); let acceptsArg = arg("accepts");
if (!sub || !url || !acceptsArg) { console.error("need --subcat --url --accepts=@file|json"); process.exit(2); }
const accepts = JSON.parse(acceptsArg.startsWith("@") ? readFileSync(acceptsArg.slice(1), "utf8") : acceptsArg);
if (!Array.isArray(accepts) || !accepts.length || accepts.some((a) => !a.network || !a.amount || !a.asset)) {
  console.error("accepts must be a non-empty array of {network,amount,asset,...}"); process.exit(2);
}
const NOW = new Date().toISOString();
const curPath = join(__dir, "curation", `${sub}.json`);
const candPath = join(__dir, "candidates", `${sub}.json`);
const cur = JSON.parse(readFileSync(curPath, "utf8"));
const cand = existsSync(candPath) ? JSON.parse(readFileSync(candPath, "utf8")) : null;
const C = cand?.candidates || [];

let hit = null;
for (const e of cur.entries || []) {
  for (let i = 0; i < (e.backends || []).length; i++) {
    const b = e.backends[i];
    if (b && typeof b === "object" && b.url === url) { b.accepts = accepts; b.probe = { ...(b.probe || {}), status: 402, payable: true, checkedAt: NOW }; hit = `curation obj (${e.id || e.name})`; }
    else if (typeof b === "number" && C[b] && (C[b].url === url || C[b].key === url)) { C[b].accepts = accepts; C[b].probe = { ...(C[b].probe || {}), status: 402, payable: true, checkedAt: NOW }; hit = `candidate #${b}`; }
  }
}
if (!hit) { console.error(`url not found in ${sub} source: ${url}`); process.exit(1); }
writeFileSync(curPath, JSON.stringify(cur, null, 2) + "\n");
if (cand) writeFileSync(candPath, JSON.stringify(cand, null, 2));
console.log(`set ${accepts.length} accepts on ${hit} :: ${url}`);
