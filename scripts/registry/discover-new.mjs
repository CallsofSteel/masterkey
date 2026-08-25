#!/usr/bin/env node
// Masterkey — ADDITIVE discovery sweep: find endpoints the ecosystem has gained since we last indexed,
// WITHOUT touching a single byte of what we already curated.
//
// Flags: --mode=deep|orthogonal|search|depth|both|all   --host=<substring>   --import=<file.json>
//        --concurrency=N   --max-pages=N
//
//   all  = deep + orthogonal + search + depth   (the real periodic sweep; every source is free)
//   both = deep + search                        (quick check)
//
// ════════ WHY THIS IS SAFE ════════
// The registry's value is not the URL list — it's the pay-tested `usage` blocks, quirks, and verification
// verdicts sitting in `scripts/registry/curation/` (797 usage blocks across 832 entries). This script
// NEVER writes there. It is READ-ONLY against every registry path, enforced by `assertWritable()` below
// rather than by convention, and it emits a report you then act on deliberately through the normal
// curation flow (CLAUDE.md → "To add / change / hide a service").
//
// It also cannot silently resurrect dead endpoints. Per the "NEVER DELETE A REGISTRY ENTRY — MARK IT"
// rule, a `status:"hidden"` entry is our memory of "we paid to test this and it's broken". Those URLs are
// loaded into the known-set too, so a re-sweep reports them as `known-hidden`, not as fresh leads. That is
// the whole point of marking instead of deleting, and it only holds if discovery respects it.
//
// ════════ THE FOUR PASSES ════════
// DEEP       — CDP Bazaar `/discovery/resources` enumerates the entire index (15k+ at time of writing),
//              paginated, no auth. Enumeration beats keyword search: it cannot miss a service just
//              because nobody thought to search for its vocabulary.
// ORTHOGONAL — `GET /v1/list-endpoints` returns the whole catalog in one call (74 APIs / 876 endpoints),
//              and it is the richest structured source available: per-endpoint method, description,
//              isPayable, docsUrl and queryParams/bodyParams with name+type+required.
// BROAD      — x402-search `/api/search` (our own app, `~/services/x402-search`) fans ONE query out to
//              SIX sources — AgentCash, CDP Bazaar, Zero, Orthogonal, Agent Wonderland, .well-known —
//              and merges them. Running the existing 338-query taxonomy through it reaches the sources
//              that have no enumeration API. Calling the deployed app rather than re-implementing its
//              adapters keeps its API keys in that app.
// DEPTH      — ask every discovered host for its OWN spec. Per the AgentCash discovery protocol, x402
//              servers publish `/openapi.json` with an `x-payment-info` block per paid operation,
//              falling back to `/.well-known/x402`. This is the highest-yield pass: an index only lists
//              what someone submitted, whereas the host's spec lists everything it actually serves.
//
// All four are free. `--mode=all` is the honest periodic sweep.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { CATEGORIES } from "./queries.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const BY_SUBCAT = join(ROOT, "data/registry/by-subcat");
const CURATION = join(__dir, "curation");
const CANDIDATES = join(__dir, "candidates");
const OUT_DIR = join(ROOT, "data/registry/discovery");

const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const XSEARCH = "https://x402-search.vercel.app/api/search";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MODE = arg("mode", "deep");
const HOST_FILTER = arg("host", "");
const IMPORT = arg("import", "");
const CONCURRENCY = Number(arg("concurrency", "6"));
const MAX_PAGES = Number(arg("max-pages", "40"));

// ── Write guard ────────────────────────────────────────────────────────────────────────────────
// Everything the registry treats as a source of truth. A bug that wrote here would destroy pay-tested
// data, so make it impossible rather than merely unlikely.
const PROTECTED = [
  BY_SUBCAT, CURATION, CANDIDATES,
  join(ROOT, "data/registry/index.json"),
  join(ROOT, "data/registry/meta.json"),
];
function assertWritable(target) {
  const t = resolve(target);
  for (const p of PROTECTED) {
    if (t === resolve(p) || t.startsWith(resolve(p) + "/")) {
      throw new Error(`REFUSING TO WRITE inside a protected registry path: ${t}\nThis script is read-only against the registry by design.`);
    }
  }
  return t;
}

// ── URL normalization ──────────────────────────────────────────────────────────────────────────
// Validated against a live Bazaar page before shipping: host lowercased, leading `www.` dropped,
// trailing slash dropped, query/fragment dropped. Path CASE IS PRESERVED — paths are case-sensitive per
// RFC and some providers depend on it.
function norm(u) {
  if (!u || typeof u !== "string") return null;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(u.trim());
  if (!m) return null;
  let host = m[1].toLowerCase().split("@").pop();
  if (host.startsWith("www.")) host = host.slice(4);
  const path = (m[2] || "/").replace(/\/+$/, "") || "/";
  return host + path;
}
const hostOf = (k) => (k || "").split("/")[0];

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function entriesOf(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.entries)) return d.entries;       // curation/<subcat>.json
  if (d && Array.isArray(d.candidates)) return d.candidates; // candidates/<subcat>.json
  return [];
}

// ── The known-set: everything we have already seen, in ANY state ───────────────────────────────
function buildKnown() {
  const known = new Map(); // normalized URL -> why we know it
  const add = (u, why) => { const k = norm(u); if (k && !known.has(k)) known.set(k, why); };

  for (const f of existsSync(BY_SUBCAT) ? readdirSync(BY_SUBCAT).filter((x) => x.endsWith(".json")) : []) {
    for (const s of readJson(join(BY_SUBCAT, f)) || []) {
      const svcHidden = s.status === "hidden";
      for (const b of s.backends || []) add(b.url, svcHidden || b.status === "hidden" ? "known-hidden" : "known-served");
      for (const o of s.operations || []) add(o.url, svcHidden || o.status === "hidden" ? "known-hidden" : "known-served");
    }
  }
  // Curation is the DURABLE layer — it can hold entries not currently projected into by-subcat.
  const walk = (dir, why) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, why); continue; }
      if (!e.name.endsWith(".json")) continue;
      for (const s of entriesOf(readJson(p))) {
        if (!s || typeof s !== "object") continue;
        add(s.url, why);
        for (const b of s.backends || []) add(b.url, why);
        for (const o of s.operations || []) add(o.url, why);
      }
    }
  };
  walk(CURATION, "known-curation");
  walk(CANDIDATES, "known-candidate"); // discovered before but never curated — re-reporting is noise

  // Hosts we currently SERVE (not hidden) = providers already vetted and working. New endpoints at these
  // are the highest-value leads: the provider's trust, payment rail and quirks are already established,
  // so indexing one is incremental rather than a fresh evaluation.
  const vettedHosts = new Set();
  for (const f of existsSync(BY_SUBCAT) ? readdirSync(BY_SUBCAT).filter((x) => x.endsWith(".json")) : []) {
    for (const s of readJson(join(BY_SUBCAT, f)) || []) {
      if (s.status === "hidden") continue;
      for (const t of [...(s.backends || []), ...(s.operations || [])]) {
        if (t.status === "hidden") continue;
        const k = norm(t.url);
        if (k) vettedHosts.add(hostOf(k));
      }
    }
  }

  // Apify resolves dynamically (~16k actors, never stored as registry entries) — treat its hosts as known.
  const apifyHosts = new Set(["api.apify.com", "apify.com", "console.apify.com"]);
  return { known, apifyHosts, vettedHosts };
}

// ── Sources ────────────────────────────────────────────────────────────────────────────────────
async function getJson(url, init = {}, ms = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { "User-Agent": UA, ...(init.headers || {}) } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** DEEP: enumerate the whole CDP Bazaar index, 1000 at a time. */
async function fetchBazaarAll() {
  const out = [];
  let offset = 0, total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await getJson(`${BAZAAR}?limit=1000&offset=${offset}`);
    const items = d?.items || [];
    if (total == null) total = d?.pagination?.total ?? null;
    if (!items.length) break;
    for (const i of items) {
      // Capture the FULL bazaar record (2026-07-30): the CDP index already carries accepts + the bazaar
      // extension (input example / output example / JSON schema) + tags + quality. Previously we kept only
      // 5 fields and consolidate-funnel then dropped accepts too — so the funnel had accepts:0%/schema:0%
      // and every wave re-probed + re-fetched openapi for data that was free here. Keep it all now.
      out.push({
        url: i.resource, name: i.serviceName || "", description: i.description || "",
        sources: ["bazaar"], accepts: i.accepts, lastUpdated: i.lastUpdated,
        tags: i.tags || null, quality: i.quality || null,
        bazaar: i.extensions?.bazaar || null,   // info.input (method/body/query/pathParams example) + output.example + schema
      });
    }
    offset += items.length;
    process.stderr.write(`\r  bazaar: ${out.length}${total ? `/${total}` : ""}   `);
    if (total != null && offset >= total) break;
  }
  process.stderr.write("\n");
  return out;
}

/**
 * ORTHOGONAL: the whole catalog in one authenticated call (74 APIs / 876 endpoints at time of writing).
 * Richest structured source we have — every endpoint carries method, description, isPayable, docsUrl and
 * queryParams/bodyParams with name+type+required. That is most of an input schema, for free, before we
 * ever pay to test. Key is read from the env or from the x402-search app that already owns it.
 */
async function fetchOrthogonalAll() {
  const key = process.env.ORTHOGONAL_API_KEY || readKeyFromSibling("ORTHOGONAL_API_KEY");
  if (!key) { console.log("  (skipped — no ORTHOGONAL_API_KEY in env or ../x402-search/.env.local)"); return []; }
  const out = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await getJson(`https://api.orthogonal.com/v1/list-endpoints?limit=500&offset=${offset}`, { headers: { Authorization: `Bearer ${key}` } });
    const apis = d?.apis || [];
    if (!apis.length) break;
    for (const a of apis) {
      const base = (a.baseUrl || "").replace(/\/+$/, "");
      for (const e of a.endpoints || []) {
        out.push({
          url: base + (e.path || ""),
          name: `${a.name || a.slug}${e.path ? " " + e.path : ""}`,
          description: e.description || a.description || "",
          sources: ["orthogonal"],
          price: e.price, method: e.method, payable: e.isPayable,
          meta: { apiSlug: a.slug, verified: a.verified, docsUrl: e.docsUrl, queryParams: e.queryParams, bodyParams: e.bodyParams },
        });
      }
    }
    offset += apis.length;
    process.stderr.write(`\r  orthogonal: ${out.length} endpoints from ${offset} apis   `);
    if (!d?.pagination?.hasMore) break;
  }
  process.stderr.write("\n");
  return out;
}

/**
 * DEPTH: ask each host to describe itself. Per the AgentCash discovery protocol, x402 servers publish
 * `/openapi.json` with an `x-payment-info` block per paid operation, falling back to `/.well-known/x402`.
 * Measured on a random sample of 60 discovered hosts: 78% answer, ~18 paid ops each (median 2).
 *
 * This is the highest-value pass and it costs nothing. An index only lists what someone submitted; the
 * host's own spec lists everything it actually serves — that's how `2s.io` shows 578 operations where the
 * Bazaar had 200. It also hands us price, method and parameter schemas up front.
 */
async function fetchOpenApiDepth(hosts) {
  const out = [];
  const queue = [...hosts];
  const total = queue.length;
  let done = 0, answered = 0;
  const worker = async () => {
    while (queue.length) {
      const h = queue.shift();
      let d = await getJson(`https://${h}/openapi.json`, {}, 12000);
      let via = "openapi";
      if (!d?.paths) { d = await getJson(`https://${h}/.well-known/x402`, {}, 12000); via = "well-known"; }
      done++;
      if (d?.paths) {
        answered++;
        const servers = Array.isArray(d.servers) && d.servers[0]?.url ? String(d.servers[0].url).replace(/\/+$/, "") : `https://${h}`;
        const base = /^https?:\/\//i.test(servers) ? servers : `https://${h}${servers}`;
        for (const [p, ops] of Object.entries(d.paths)) {
          for (const [m, op] of Object.entries(ops || {})) {
            if (!["get", "post", "put", "patch", "delete"].includes(m.toLowerCase())) continue;
            const pay = op?.["x-payment-info"] || op?.["x-payment"] || null;
            out.push({
              url: base + p, name: op?.summary || op?.operationId || `${m.toUpperCase()} ${p}`,
              description: op?.summary || op?.description || "", sources: [`self:${via}`],
              method: m.toUpperCase(), payable: !!pay,
              price: pay?.price ?? pay?.amount ?? null,
              meta: { paymentInfo: pay || undefined, tags: op?.tags, params: op?.parameters ? op.parameters.length : undefined },
            });
          }
        }
      } else if (Array.isArray(d?.endpoints)) {
        answered++;
        for (const e of d.endpoints) out.push({ url: e.url || e.resource, name: e.name || "", description: e.description || "", sources: ["self:well-known"], price: e.price, method: e.method, payable: true });
      }
      if (done % 10 === 0 || !queue.length) process.stderr.write(`\r  depth: ${done}/${total} hosts, ${answered} answered, ${out.length} ops   `);
    }
  };
  await Promise.all(Array.from({ length: Math.max(CONCURRENCY, 12) }, worker));
  process.stderr.write("\n");
  return out;
}

/** Read a key from the sibling x402-search app rather than duplicating secrets into this repo. */
function readKeyFromSibling(name) {
  for (const p of [resolve(ROOT, "../x402-search/.env.local"), resolve(ROOT, "../x402-search/.env")]) {
    if (!existsSync(p)) continue;
    const m = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(p, "utf8"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/** BROAD: run the taxonomy through our own six-source aggregator. */
async function fetchSearchAll() {
  const queries = [];
  for (const c of CATEGORIES) for (const s of c.subcategories) for (const q of s.queries) queries.push({ q, subcat: s.slug });
  const totalQ = queries.length;
  const out = [];
  let done = 0;
  const worker = async () => {
    while (queries.length) {
      const { q, subcat } = queries.shift();
      const d = await getJson(`${XSEARCH}?q=${encodeURIComponent(q)}`);
      for (const r of d?.results || []) {
        out.push({ url: r.url, name: r.title || r.name || "", description: r.description || "", sources: r.sources || ["x402-search"], price: r.price, method: r.method, foundVia: q, subcat });
      }
      process.stderr.write(`\r  search: ${++done}/${totalQ} queries, ${out.length} hits   `);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log("Building known-set from the existing registry (read-only)…");
  const { known, apifyHosts, vettedHosts } = buildKnown();
  const hiddenCount = [...known.values()].filter((v) => v === "known-hidden").length;
  console.log(`  ${known.size} known URLs  (${hiddenCount} hidden = already pay-tested and rejected)\n`);

  // `all` = every free source, in increasing cost of time. Depth runs LAST because it seeds itself from
  // the hosts the earlier passes discovered.
  const want = (m) => MODE === "all" || MODE === m || (MODE === "both" && (m === "deep" || m === "search"));
  // x402-search is our OWN DEPRECATED legacy aggregator (owner 2026-07-30) — do NOT use it as a source.
  // The real sources are bazaar (CDP, rich: accepts+schema+examples) + orthogonal + agentcash. The search
  // pass is now gated behind an explicit --include-xsearch so "all"/"search" can't silently pull it.
  const INCLUDE_XSEARCH = args.includes("--include-xsearch");

  const raw = [];
  if (want("deep")) { console.log("DEEP pass — enumerating CDP Bazaar…"); raw.push(...await fetchBazaarAll()); }
  if (want("orthogonal")) { console.log("ORTHOGONAL pass — full catalog…"); raw.push(...await fetchOrthogonalAll()); }
  if (want("search") && INCLUDE_XSEARCH) { console.log("BROAD pass — taxonomy queries via x402-search (DEPRECATED, opt-in)…"); raw.push(...await fetchSearchAll()); }
  else if (want("search")) { console.log("SKIP x402-search pass — deprecated source (pass --include-xsearch to force)."); }
  if (IMPORT) {
    const imp = readJson(resolve(IMPORT)) || [];
    const list = Array.isArray(imp) ? imp : entriesOf(imp);
    for (const i of list) raw.push({ url: i.url || i.resource, name: i.name || i.serviceName || "", description: i.description || "", sources: i.sources || ["import"] });
    console.log(`  imported ${list.length} from ${IMPORT}`);
  }

  // DEPTH seeds from every host seen so far PLUS every host we already serve — providers we trust are
  // exactly the ones whose new endpoints we most want, and an index may not have caught up with them.
  if (want("depth")) {
    const hosts = new Set();
    for (const r of raw) { const k = norm(r.url); if (k) hosts.add(hostOf(k)); }
    for (const h of vettedHosts) hosts.add(h);
    const list = [...hosts].filter((h) => !HOST_FILTER || h.includes(HOST_FILTER.toLowerCase()));
    console.log(`DEPTH pass — asking ${list.length} hosts for their own /openapi.json…`);
    raw.push(...await fetchOpenApiDepth(list));
  }

  // Fold duplicates across sources, then classify against the known-set.
  const seen = new Map();
  for (const r of raw) {
    const k = norm(r.url);
    if (!k) continue;
    if (HOST_FILTER && !hostOf(k).includes(HOST_FILTER.toLowerCase())) continue;
    const prev = seen.get(k);
    if (prev) { prev.sources = [...new Set([...prev.sources, ...(r.sources || [])])]; continue; }
    seen.set(k, { key: k, host: hostOf(k), url: r.url, name: r.name, description: r.description,
      sources: r.sources || [], price: r.price ?? null, method: r.method ?? null,
      payable: r.payable ?? null,
      // carry the bazaar enrichment through the report (was dropped here → funnel had accepts:0%/schema:0%)
      ...(r.accepts ? { accepts: r.accepts } : {}), ...(r.bazaar ? { bazaar: r.bazaar } : {}),
      ...(r.tags ? { tags: r.tags } : {}), ...(r.quality ? { quality: r.quality } : {}),
      ...(r.meta ? { meta: r.meta } : {}) });
  }

  const fresh = [], alreadyKnown = [], hiddenHits = [], apify = [];
  for (const [k, v] of seen) {
    if (apifyHosts.has(v.host)) { apify.push(v); continue; }
    const why = known.get(k);
    if (!why) fresh.push(v);
    else if (why === "known-hidden") hiddenHits.push(v);
    else alreadyKnown.push(v);
  }

  const byHost = {};
  for (const f of fresh) (byHost[f.host] ||= []).push(f);
  const hostRank = Object.entries(byHost).sort((a, b) => b[1].length - a[1].length);

  // Two very different kinds of lead. At a host we ALREADY serve, the provider's trust, payment rail and
  // quirks are established — indexing a new endpoint there is incremental. At an unknown host, everything
  // must be evaluated from scratch. Neither is filtered out; they're separated so the later pay-test pass
  // can start where the evidence is strongest.
  const atVetted = hostRank.filter(([h]) => vettedHosts.has(h));
  const atNew    = hostRank.filter(([h]) => !vettedHosts.has(h));
  const sum = (r) => r.reduce((n, [, l]) => n + l.length, 0);

  console.log(`\n════════ RESULT ════════`);
  console.log(`  discovered (unique)      : ${seen.size}`);
  console.log(`  already in our registry  : ${alreadyKnown.length}`);
  console.log(`  hidden (tested, rejected): ${hiddenHits.length}   <- deliberately NOT re-suggested`);
  console.log(`  apify (dynamic provider) : ${apify.length}`);
  console.log(`  GENUINELY NEW            : ${fresh.length}  across ${hostRank.length} hosts`);
  console.log(`     ├─ at providers we already serve : ${sum(atVetted)}  (${atVetted.length} hosts)  <- start here`);
  console.log(`     └─ at providers new to us        : ${sum(atNew)}  (${atNew.length} hosts)\n`);
  console.log(`  expansion at providers we already serve:`);
  for (const [h, l] of atVetted.slice(0, 15)) console.log(`    ${String(l.length).padStart(5)}  ${h}`);
  console.log(`\n  biggest new providers:`);
  for (const [h, l] of atNew.slice(0, 15)) console.log(`    ${String(l.length).padStart(5)}  ${h}`);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = assertWritable(join(OUT_DIR, `new-endpoints-${stamp}.json`));
  writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: MODE,
    hostFilter: HOST_FILTER || null,
    totals: {
      discovered: seen.size, known: alreadyKnown.length, hidden: hiddenHits.length, apify: apify.length,
      new: fresh.length,
      newAtVettedProviders: sum(atVetted), newAtNewProviders: sum(atNew),
      payable: fresh.filter((f) => f.payable === true).length,
    },
    newAtVettedProviders: Object.fromEntries(atVetted),
    newAtNewProviders: Object.fromEntries(atNew),
    byHost: Object.fromEntries(hostRank.map(([h, l]) => [h, l])),
    hiddenRediscovered: hiddenHits.map((h) => ({ key: h.key, name: h.name })),
  }, null, 2));

  console.log(`\n  report -> ${outFile.replace(ROOT + "/", "")}`);
  console.log(`  NOTHING in data/registry/{by-subcat,index,meta} or scripts/registry/{curation,candidates} was modified.`);
  console.log(`  To index any of these, go through the normal curation flow (CLAUDE.md -> "To add / change / hide a service").`);
})();
