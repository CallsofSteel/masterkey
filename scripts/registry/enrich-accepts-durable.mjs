/**
 * enrich-accepts-durable.mjs — backfill empty `payment.accepts[]` DURABLY, at the SOURCE.
 *
 * Why this exists (vs enrich-accepts.mjs): the old script wrote accepts only into
 * data/registry/by-subcat/*.json — but curate.mjs REGENERATES by-subcat from candidates/ +
 * curation/, so those writes get wiped on the next rebuild. This script writes accepts to the
 * SOURCE instead:
 *   - candidate-ref backend (integer in curation entry.backends) → candidates/<sub>.json [idx].accepts
 *     (curate's backendFrom reads `c.accepts`).
 *   - manual backend object (in curation entry.backends) → that object's .accepts
 *     (curate's manualBackend reads `spec.accepts`).
 * So after a curate, accepts persist forever.
 *
 * It re-probes the live 402 FRESH (trusts nothing already in by-subcat). It touches ONLY `accepts`
 * (+ the candidate/obj `probe` stamp) — never usage / price / quirks / status. It does NOT write
 * by-subcat (run curate.mjs afterwards). Skips hidden services and unresolved URL templates.
 *
 * Usage:
 *   node scripts/registry/enrich-accepts-durable.mjs --subcat=image-generation [--subcat=...]
 *   node scripts/registry/enrich-accepts-durable.mjs --all
 *   [--dry-run] [--cap=4] [--timeout=20000]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CAND = join(__dir, "candidates");
const CUR = join(__dir, "curation");
const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const getAll = (k) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.split("=")[1]);
const DRY = has("dry-run");
const CAP = Number(getAll("cap")[0] || 4);
const TIMEOUT = Number(getAll("timeout")[0] || 20000);
const TRIES = Number(getAll("tries")[0] || 3);
const NOW = new Date().toISOString();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const onlySubs = getAll("subcat");
const allCur = readdirSync(CUR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
const subs = has("all") ? allCur : onlySubs;
if (!subs.length) { console.error("specify --subcat=<x> (repeatable) or --all"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// unresolved URL template → can't probe (would 404 / wrong route)
function isTemplate(url) {
  let path = url;
  try { path = new URL(url).pathname; } catch {}
  if (/[:{]/.test(path)) return true;                 // /:id  /{id}
  if (/\/[A-Z][A-Z0-9_]{3,}(\/|$)/.test(path)) return true; // /AVAILABILITY_ID /DRAFT_ID
  return false;
}

async function fetchRaw(url, method, probeBody) {
  const isBody = ["POST", "PUT", "PATCH"].includes(method);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      body: isBody ? JSON.stringify(probeBody && Object.keys(probeBody).length ? probeBody : {}) : null,
      headers: { "User-Agent": UA, Accept: "application/json", ...(isBody ? { "Content-Type": "application/json" } : {}) },
      redirect: "manual", signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    return { status: null, headers: new Headers(), text: "", error: String(e?.name || e) };
  } finally { clearTimeout(t); }
}

function extractAccepts({ headers, text }) {
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === "payment-required" && v) {
      try { const pr = JSON.parse(Buffer.from(v, "base64").toString("utf8")); const a = pr?.accepts || pr?.paymentRequirements; if (Array.isArray(a) && a.length) return a; } catch {}
    }
  }
  if (text) { try { const b = JSON.parse(text); const a = b?.accepts || b?.paymentRequirements || b?.data?.accepts; if (Array.isArray(a) && a.length) return a; } catch {} }
  return null;
}
function normAccept(a) {
  if (!a || typeof a !== "object") return null;
  const amt = a.amount ?? a.maxAmountRequired;
  const out = { scheme: a.scheme || "exact", network: a.network ?? "", amount: amt != null ? String(amt) : "", asset: a.asset ?? "" };
  if (a.payTo != null) out.payTo = a.payTo;
  if (a.maxTimeoutSeconds != null) out.maxTimeoutSeconds = a.maxTimeoutSeconds;
  if (a.extra != null) out.extra = a.extra;
  return out.amount && out.asset ? out : null;
}
async function probeMethod(url, method, probeBody) {
  let last = { status: null };
  for (let i = 0; i < TRIES; i++) {
    const r = await fetchRaw(url, method, probeBody); last = r;
    if (r.status === 402) { const acc = extractAccepts(r); return { kind: acc ? "filled" : "payable", method, accepts: acc ? acc.map(normAccept).filter(Boolean) : [] }; }
    if (r.status >= 200 && r.status < 300) return { kind: "free", method, accepts: [] };
    if ([400, 401, 403, 404, 405, 410].includes(r.status)) return { kind: "hard", status: r.status, method, accepts: [] };
    await sleep(500 * (i + 1));
  }
  return { kind: "soft", status: last.status, method, accepts: [] };
}
const RANK = { filled: 5, payable: 4, free: 3, hard: 2, soft: 1 };
async function reprobe(url, method, probeBody) {
  const order = []; const m0 = (method || "POST").toUpperCase();
  if (m0 !== "OPTIONS" && m0 !== "HEAD") order.push(m0);
  for (const m of ["POST", "GET"]) if (!order.includes(m)) order.push(m);
  let best = { kind: "soft", status: null, method: order[0], accepts: [] };
  for (const m of order) { const r = await probeMethod(url, m, probeBody); if (RANK[r.kind] > RANK[best.kind]) best = r; if (r.kind === "filled") break; await sleep(150); }
  return best;
}
async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

const malformed = (acc) => !Array.isArray(acc) || acc.length === 0 || acc.some((a) => !a.amount || !a.asset || !a.network);

let totFilled = 0, totEmpty = 0, totDead = 0, totSkip = 0, totJobs = 0;
const deadList = [];

for (const sub of subs) {
  const candPath = join(CAND, `${sub}.json`);
  const curPath = join(CUR, `${sub}.json`);
  if (!existsSync(curPath)) { console.warn(`  ! no curation for ${sub}`); continue; }
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  const cand = existsSync(candPath) ? JSON.parse(readFileSync(candPath, "utf8")) : { candidates: [] };
  const C = cand.candidates || [];

  // collect jobs: {srcObj, url, method} where srcObj is the candidate OR the manual backend object
  const jobs = [];
  for (const e of cur.entries || []) {
    if (e.status === "hidden") continue;
    for (const b of e.backends || []) {
      let srcObj = null, url = null, method = "POST";
      if (typeof b === "number") { srcObj = C[b]; if (!srcObj) continue; url = srcObj.url || srcObj.key; method = srcObj.method || srcObj.probeMethod || "POST"; }
      else if (b && typeof b === "object") { srcObj = b; url = b.url; method = b.method || "POST"; }
      if (!srcObj || !url) continue;
      if (isTemplate(url)) { totSkip++; continue; }
      if (!malformed(srcObj.accepts)) continue; // already has good accepts at source
      const probeBody = srcObj.modelParam?.name ? { [srcObj.modelParam.name]: srcObj.modelParam.value } : {};
      jobs.push({ srcObj, url, method, probeBody, svc: e.name || e.id });
    }
  }
  totJobs += jobs.length;
  if (!jobs.length) { console.log(`  = ${sub}: nothing to backfill`); continue; }

  const results = await pool(jobs, CAP, async (j) => ({ j, r: await reprobe(j.url, j.method, j.probeBody) }));
  let filled = 0, empty = 0, dead = 0;
  for (const { j, r } of results) {
    if (r.kind === "filled" && r.accepts.length) {
      j.srcObj.accepts = r.accepts;
      j.srcObj.probe = { ...(j.srcObj.probe || {}), status: 402, method: r.method, payable: true, checkedAt: NOW };
      filled++;
    } else if (r.kind === "payable") { empty++; }
    else if (r.kind === "hard") { dead++; deadList.push(`${sub} :: ${j.svc} :: ${r.status} :: ${j.url}`); }
    else { empty++; } // soft/free: leave as-is
  }
  totFilled += filled; totEmpty += empty; totDead += dead;
  console.log(`  ${sub}: ${jobs.length} probed → ${filled} filled, ${empty} still-empty, ${dead} dead(404/401)`);
  if (!DRY) {
    if (existsSync(candPath)) writeFileSync(candPath, JSON.stringify(cand, null, 2));
    writeFileSync(curPath, JSON.stringify(cur, null, 2) + "\n");
  }
}

console.log(`\n--- durable accepts backfill ${DRY ? "(DRY-RUN)" : ""} ---`);
console.log(`subcats: ${subs.length} · jobs: ${totJobs} · FILLED: ${totFilled} · still-empty: ${totEmpty} · dead(404/401): ${totDead} · skipped(template): ${totSkip}`);
if (deadList.length) { console.log(`\ndead backends (re-probe 404/401 — review, NOT auto-hidden):`); deadList.slice(0, 60).forEach((d) => console.log("  " + d)); }
console.log(DRY ? "\n(dry-run — wrote nothing)" : `\nwrote source (candidates + curation). Run curate.mjs --subcat=<each> to regenerate by-subcat.`);
