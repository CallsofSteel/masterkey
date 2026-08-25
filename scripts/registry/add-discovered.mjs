#!/usr/bin/env node
// Masterkey — ADD newly-discovered endpoints to the registry. Additive by construction.
//
// Flags:
//   --funnel=<file>     funnel-*.json from consolidate-funnel.mjs   (default: newest)
//   --batch=N           which batch to work                          (default: 1)
//   --subcat=<slug>     REQUIRED for --apply. Where these services land.
//   --cap=0.25          per-call spend ceiling passed to qa-pay
//   --limit=N           only the first N endpoints of the batch (use for samples)
//   --pay               actually pay-test (default: FREE probe only)
//   --apply             write staged entries into curation/<subcat>.json
//   --model=haiku       model for the naming pass (default haiku — fast, cheap, sufficient)
//   --rename            re-name endpoints already named (default: skip them)
//
// RESUMABLE. Every endpoint's state lives in data/registry/discovery/index-checklist.json and is written
// after EACH endpoint, not at the end. Kill it at any point and re-run: naming skips what is named,
// probing skips what is probed, paying skips what is paid. Nothing is ever done twice, and an interrupted
// batch never has to be restarted from scratch.
//
// Default run is FREE and writes nothing but a staging file. Money needs --pay. Registry writes need
// --apply. Nothing happens implicitly.
//
// ════════ WHY A NEW SCRIPT AND NOT THE QA HARNESS ════════
// apply-qa-patches.mjs is an UPDATE tool: it looks up `curation.entries.find(e => slug(e.name) === id)`
// and SKIPS anything it cannot find. Pointed at new discoveries it would silently skip all of them. It
// also keys on slug(name) — the §5.5B trap. This script only ever ADDS, and keys on URL.
//
// ════════ THE FIVE REQUIREMENTS, EACH ENFORCED ════════
//
// 1. ADDITIVE — existing entries are never touched.
//    --apply appends to curation/<subcat>.json and then ASSERTS that every pre-existing entry is
//    byte-identical afterwards. If any differs, it restores the file from the in-memory original and
//    aborts. by-subcat/ and index.json are never written here at all; they are regenerated later by
//    curate.mjs, which is a pure projection of curation/.
//
// 2. NO SILENT DROPS (§5.5B) — slug(name) collisions are fatal, not quiet.
//    Checked against BOTH existing curation entries and other members of the same batch. A collision
//    ABORTS with the offending names listed, because the alternative is losing an endpoint invisibly.
//    We measured 2,486 name collisions in the current funnel, so this is not hypothetical.
//
// 3. ACCEPTS CAPTURED AT INDEX TIME (§5.5C) — never deferred to a backfill.
//    Decoded from the live 402 from BOTH the `payment-required` header AND the JSON body, because
//    first-party 402s and gateway 402s each use a different one. An endpoint with no decodable accepts
//    is NOT staged — `isPayable()` would skip it anyway and it would sit in the registry unpayable.
//
// 4. NO GUESSED PROVENANCE (§5.5D) — firstParty and team are NEVER set here.
//    curate.mjs derives `firstParty` from data/registry/first-party.json and `team` from teams.mjs, by
//    host. So a known host gets tagged automatically and an unknown host gets nothing — which is the
//    honest answer. Hosts that end up with neither are listed at the end for the owner to classify.
//    Guessing "is this the owner or a reseller?" is exactly what §5.5D says to ask about.
//
// 5. DONE ONCE — everything an entry needs is captured in this single pass.
//    accepts + method + price + inputSchema from the probe; usage.callShape / outputShape / quirks /
//    guide from the paid call. A checkpoint records every endpoint already paid for, so a re-run never
//    pays twice.
//
// ════════ WHAT IS DELIBERATELY LEFT TO A HUMAN ════════
// Service-vs-backend modelling (§5.5A/B). Every endpoint is staged as its OWN service. Folding one in as
// a backend of an existing service requires proving the request/response CONTRACT matches, which a script
// cannot do — and §5.5B is explicit that when unsure you keep them SEPARATE, because "a later merge is
// cheap; an untangle is not". Candidate merges are REPORTED, never performed.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const CURATION = join(__dir, "curation");
const DISCOVERY = join(ROOT, "data/registry/discovery");
const STAGING = join(DISCOVERY, "staged");
const CHECKLIST = join(DISCOVERY, "index-checklist.json");
const QA_PAY = join(__dir, "dist/qa-pay.mjs");

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const has = (k) => argv.includes(`--${k}`);
const BATCH = Number(arg("batch", "1"));
const SUBCAT = arg("subcat", "");
const CAP = arg("cap", "0.25");
const LIMIT = Number(arg("limit", "0"));
const MODEL = arg("model", "haiku");
const RENAME = has("rename");
const PAY = has("pay");
const APPLY = has("apply");

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

// ── §5.5C: decode accepts from the live 402 — header AND body ──────────────────────────────────
function decodeAccepts(headers, bodyText) {
  const out = [];
  const push = (arr) => { for (const a of arr || []) if (a && (a.payTo || a.asset)) out.push(a); };
  const h = headers.get("payment-required") || headers.get("x-payment-required");
  if (h) {
    for (const cand of [h, Buffer.from(h, "base64").toString("utf8")]) {
      try { const j = JSON.parse(cand); push(j.accepts || j.paymentRequirements); break; } catch { /* try next */ }
    }
  }
  try { const j = JSON.parse(bodyText); push(j.accepts || j.paymentRequirements); } catch { /* not json */ }
  // de-dupe by network+payTo+amount
  const seen = new Set();
  return out.filter((a) => { const k = `${a.network}|${a.payTo}|${a.amount}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function probe(url, method) {
  const init = { method: method || "POST", headers: { "Content-Type": "application/json" } };
  if ((method || "POST") !== "GET") init.body = "{}";
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    const text = await res.text().catch(() => "");
    return { status: res.status, accepts: res.status === 402 ? decodeAccepts(res.headers, text) : [], free: res.ok, body: text.slice(0, 400) };
  } catch (e) {
    return { status: 0, accepts: [], free: false, error: String(e.message || e).slice(0, 120) };
  }
}

// ── Per-host OpenAPI spec: the single best free source of truth about an endpoint ──────────────
// Discovery gives us AgentCash's `semanticDescription`, which is an embedding blob ("Origin URL: …
// Origin hostname: … Origin brand: …") — useless as a catalog description. The host's own spec gives a
// real human summary, the request schema, and the response schema. Fetched ONCE per host and cached.
// Real, publicly-reachable assets for synthesising request bodies. An endpoint wanting an image must
// get a REAL image — "https://example.com/image.jpg" just buys a 400, which we proved twice at $0.01 a go.
//
// The list is deliberately SHORT and states what we do NOT have. When a required field needs an asset type
// that is absent, the correct answer is needsInput:true (park it), NOT a plausible-looking fake URL. A
// fabricated "https://example.org/audio.mp3" costs real money to discover is wrong.
// Assets are liveness-checked at start-up rather than trusted, because hosted files rot.
const ASSETS = [
  { kind: "image", url: "https://i.img402.dev/zx8qjbsfu0.png", note: "1024x1024 PNG, public, permanent" },
  { kind: "image", url: "https://i.img402.dev/1qkgnwuf24.png", note: "1024x1024 PNG, public, permanent" },
];
const HAVE_NOT = ["audio", "video", "pdf/document", "uploaded-file ids", "job ids", "session tokens"];
let ASSETS_DOC = "";
async function buildAssetsDoc() {
  const live = [];
  for (const a of ASSETS) {
    try {
      const res = await fetch(a.url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (res.ok) live.push(`  ${a.kind} URL: ${a.url}  (${a.note})`);
    } catch { /* dead asset — simply not offered */ }
  }
  live.push('  web page URL: https://example.org   (stable, safe to fetch/screenshot)');
  live.push('  domain: example.org', '  plain text: "hello world"', '  email: test@example.org');
  ASSETS_DOC = live.join("\n") +
    `\nWE DO NOT HAVE (never invent a URL for these — set needsInput:true instead): ${HAVE_NOT.join(", ")}.`;
  return live.length;
}

const specCache = new Map();
async function hostSpec(host) {
  if (specCache.has(host)) return specCache.get(host);
  let spec = null;
  for (const u of [`https://${host}/openapi.json`, `http://${host}/openapi.json`]) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (res.ok) { const j = await res.json(); if (j?.paths) { spec = j; break; } }
    } catch { /* try next */ }
  }
  specCache.set(host, spec);
  return spec;
}
/** The operation object for a URL from its host spec, plus a normalized view of what we need. */
function specFor(spec, url, method) {
  if (!spec) return null;
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const ops = spec.paths?.[path] || spec.paths?.[path.replace(/\/$/, "")];
  const op = ops?.[(method || "post").toLowerCase()] || ops?.post || ops?.get;
  if (!op) return null;
  const schema = op.requestBody?.content?.["application/json"]?.schema || null;
  const resp = op.responses?.["200"]?.content?.["application/json"]?.schema || null;
  return { summary: op.summary || op.description || "", inputSchema: schema, outputSchema: resp, tags: op.tags || [] };
}

/**
 * Ask the model to do the three judgement calls we must NOT guess, in one call per endpoint:
 *   • a clean human description
 *   • category/subcategory from the REAL 97-slug taxonomy (never invented)
 *   • a MINIMAL valid request body from the input schema — or `needsInput:true` when the endpoint
 *     requires an artifact only another call can produce (e.g. an image_id from a prior upload).
 * That last one matters financially: paying with `{}` buys a 400. We proved that — it cost $0.01 and
 * returned "Validation failed".
 */
function enrich(rows, taxonomy) {
  const payload = rows.map((r) => ({
    url: r.url, method: r.method, name: r.name, priceUsd: r.priceUsd,
    summary: r.spec?.summary || "", inputSchema: r.spec?.inputSchema || null,
  }));
  const prompt =
    "You are indexing pay-per-call APIs into a catalog. For EACH input object return ONE JSON object with keys: " +
    "url, description, category, subcategory, tags, modalityIn, modalityOut, kind, sampleBody, needsInput, reason.\n" +
    "description: ONE clear sentence — what it does AND what you get back. Never empty. No marketing.\n" +
    "category/subcategory: EXACTLY one pair from the allowed list below. Never invent one.\n" +
    "tags: REQUIRED, 3-6 short lowercase keywords. Never an empty array.\n" +
    "modalityIn/modalityOut: REQUIRED non-empty arrays from text|image|video|audio|file.\n" +
    "kind: \"model\" if it runs a named AI model, else \"api\".\n" +
    "sampleBody: a MINIMAL valid request body satisfying every REQUIRED field in inputSchema. " +
    "Use these REAL working assets when a field needs one (do NOT invent example.com URLs):\n" + ASSETS_DOC + "\n" +
    "needsInput: true whenever a REQUIRED field cannot be satisfied by the assets above — either it needs an " +
    "artifact another endpoint must create first (uploaded file id, job id, session token), OR it needs an asset " +
    "type we do not have. Then sampleBody=null and reason names the exact field. NEVER invent a plausible URL for " +
    "an asset type listed as unavailable: a wrong body costs real money and returns nothing.\n" +
    "Output a JSON array only. No prose, no code fences.\n\nALLOWED category/subcategory:\n" + taxonomy;
  let out = "";
  try {
    out = execFileSync("claude", ["-p", "--model", MODEL, "--output-format", "text", prompt],
      { input: JSON.stringify(payload), encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { console.error(`  enrich call failed: ${String(e.message || e).slice(0, 120)}`); return new Map(); }
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return new Map();
  try { return new Map(JSON.parse(m[0]).map((o) => [o.url, o])); } catch { return new Map(); }
}

// ── The checklist: single source of truth for how far each endpoint has got ────────────────────
// Statuses form a ladder: todo → named → probed → paid → staged → applied. Two terminal side-exits:
//   rejected           the probe proved it is not payment-or-nothing (dead, or needs an API key)
//   deferred-over-cap  it IS payable but costs more than --cap. NOT a failure and NOT lost — it stays on
//                      the checklist so an owner can raise the cap and come back to it deliberately.
function loadChecklist() { return readJson(CHECKLIST) || { updatedAt: null, endpoints: {} }; }
function saveChecklist(cl) {
  cl.updatedAt = new Date().toISOString();
  mkdirSync(DISCOVERY, { recursive: true });
  writeFileSync(CHECKLIST, JSON.stringify(cl, null, 2));
}
function summarize(cl) {
  const c = {};
  for (const e of Object.values(cl.endpoints)) c[e.status] = (c[e.status] || 0) + 1;
  return c;
}

/**
 * Name a batch of endpoints as "Brand Operation" (§5.5A: a Service is one capability under its BRAND,
 * e.g. "Perplexity Search" — never a sentence). Discovery hands us descriptions, and using those as names
 * both reads terribly and drives slug collisions: the raw funnel had 2,486 of them.
 *
 * Uses `claude -p` headless with Haiku — this is pattern-matching a brand and a verb out of a URL plus a
 * description, not reasoning, so the small fast model is the right tool. Batched ~20 per call because
 * process start-up dominates the cost.
 */
function nameEndpoints(rows) {
  const lines = rows.map((r) => `${r.url} :: ${(r.description || r.name || "").slice(0, 160)}`).join("\n");
  const prompt =
    'For each input line "<url> :: <description>" output exactly one line: <url> | <Name>. ' +
    'Name is "Brand Operation" style, Title Case, 2-5 words, e.g. "Perplexity Search", "Stripe Create Charge". ' +
    'The Brand MUST be derived from the HOST ONLY (stablemerch.dev -> StableMerch, socialx402.com -> SocialX402). ' +
    'NEVER take the brand from the description — descriptions often name a different company that merely resells ' +
    'or is mentioned. Derive the Operation from the path/description. ' +
    'Names must be DISTINCT from each other. No descriptions, no numbering, no commentary, no code fences.';
  let out = "";
  try {
    out = execFileSync("claude", ["-p", "--model", MODEL, "--output-format", "text", prompt],
      { input: lines, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { console.error(`  naming call failed: ${String(e.message || e).slice(0, 120)}`); return new Map(); }
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\S+)\s*\|\s*(.+?)\s*$/.exec(line);
    if (m && /^https?:\/\//.test(m[1])) map.set(m[1], m[2].replace(/^["'`]|["'`]$/g, "").trim());
  }
  return map;
}

// ── Load the batch ─────────────────────────────────────────────────────────────────────────────
const funnelFile = arg("funnel", "") ||
  (existsSync(DISCOVERY) ? readdirSync(DISCOVERY).filter((f) => f.startsWith("funnel-")).sort().pop() : null);
if (!funnelFile) { console.error("no funnel-*.json found — run consolidate-funnel.mjs first"); process.exit(1); }
const funnel = readJson(funnelFile.includes("/") ? funnelFile : join(DISCOVERY, funnelFile));
const batch = (funnel?.batches || []).find((b) => b.id === BATCH);
if (!batch) { console.error(`batch ${BATCH} not found (${funnel?.batches?.length ?? 0} batches)`); process.exit(1); }

let targets = batch.endpoints;
if (LIMIT > 0) targets = targets.slice(0, LIMIT);
console.log(`funnel : ${funnelFile.replace(ROOT + "/", "")}`);
console.log(`batch  : #${BATCH} — ${batch.hosts.join(", ")}`);
console.log(`targets: ${targets.length}${LIMIT ? ` (limited from ${batch.endpoints.length})` : ""}`);
console.log(`mode   : ${PAY ? "PAY" : "FREE probe"}${APPLY ? " + APPLY to curation" : " (staging only)"}  cap=$${CAP}\n`);

const cl = loadChecklist();
// Seed any endpoint of this batch not yet on the checklist. Existing rows keep their state — that is
// what makes a re-run resume rather than restart.
for (const t of targets) {
  if (!cl.endpoints[t.key]) {
    cl.endpoints[t.key] = { key: t.key, url: t.url, host: t.host, method: t.method || "POST", batch: BATCH,
      description: t.description || "", status: "todo", updatedAt: new Date().toISOString() };
  }
}
saveChecklist(cl);
const rows = targets.map((t) => cl.endpoints[t.key]);
const mark = (r, patch) => { Object.assign(r, patch, { updatedAt: new Date().toISOString() }); saveChecklist(cl); };
console.log(`checklist: ${Object.keys(cl.endpoints).length} endpoints tracked · this batch ${JSON.stringify(summarize({ endpoints: Object.fromEntries(rows.map((r) => [r.key, r])) }))}\n`);

// ── Phase 0: NAME (§5.5A) — skipped for anything already named ─────────────────────────────────
const needName = rows.filter((r) => RENAME || !r.name);
if (needName.length) {
  console.log(`── Phase 0: naming ${needName.length} endpoint(s) via claude -p (${MODEL}) ──`);
  for (let i = 0; i < needName.length; i += 20) {
    const chunk = needName.slice(i, i + 20);
    const named = nameEndpoints(chunk);
    for (const r of chunk) {
      const n = named.get(r.url);
      if (n) {
        // Enforce the host-brand rule rather than trusting it: a name whose leading token has nothing to do
        // with the host means the model took the brand from the description (socialx402.com was being named
        // "StableSocial …"), which would mislabel the provider and collide with the real brand's entries.
        const hostToken = r.host.replace(/^(api|x402|www)\./, "").split(".")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
        const lead = n.split(/\s+/)[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
        const fixed = hostToken && lead && !hostToken.includes(lead) && !lead.includes(hostToken)
          ? `${hostToken.charAt(0).toUpperCase() + hostToken.slice(1)} ${n.split(/\s+/).slice(1).join(" ")}`.trim()
          : n;
        if (fixed !== n) console.log(`  ${fixed}   (brand corrected from "${n.split(/\s+/)[0]}" — host is ${r.host})`);
        else console.log(`  ${fixed}`);
        mark(r, { name: fixed, status: r.status === "todo" ? "named" : r.status });
      }
      else console.log(`  (unnamed — left todo) ${r.url.slice(0, 70)}`);
    }
  }
} else console.log("── Phase 0: naming — all already named (resumed) ──");

// ── Phase A1: ensure each row has its host's OpenAPI operation (free, cached per host) ─────────
const needSpec = rows.filter((r) => r.spec === undefined);
if (needSpec.length) {
  console.log(`── Phase A1: fetching specs for ${needSpec.length} endpoint(s) ──`);
  for (const r of needSpec) {
    const spec = specFor(await hostSpec(r.host), r.url, r.method);
    // A spec arriving late invalidates any enrichment that was made without one — the request body was
    // guessed blind, which is exactly what buys a 400.
    const invalidate = spec?.inputSchema && r.enriched && !r.enrichedFromSpec;
    mark(r, { spec: spec ?? null, ...(invalidate ? { enriched: null } : {}) });
    console.log(`  ${spec?.inputSchema ? "schema" : spec ? "summary-only" : "no spec"}${invalidate ? "  (re-enrich)" : ""}  ${r.name || r.url.slice(0, 50)}`);
  }
}

// A paid call that returned 4xx bought nothing usable. If a schema has since arrived, demote it back to
// `probed` so it is re-enriched and re-paid ONCE — recovering the purchase rather than paying twice for
// the same information. Runs BEFORE enrichment so the corrected body actually reaches the retry.
const retry = rows.filter((r) => r.status === "paid" && (r.pay?.httpStatus ?? 0) >= 400 && r.spec?.inputSchema && !r.repaid);
for (const r of retry) mark(r, { status: "probed", repaid: true, enriched: null });
if (retry.length) console.log(`  → ${retry.length} paid-but-4xx endpoint(s) demoted for one schema-backed retry\n`);

// ── Phase A: FREE probe — payment-or-nothing + accepts (§5.5C) ─────────────────────────────────
const needProbe = rows.filter((r) => r.name && !r.probe);
console.log(`\n── Phase A: probing ${needProbe.length} (${rows.length - needProbe.length} already probed) ──`);
for (const r of needProbe) {
  if (r.spec === undefined) mark(r, { spec: specFor(await hostSpec(r.host), r.url, r.method) ?? null });
  const p = await probe(r.url, r.method);
  const payable = p.status === 402 && p.accepts.length > 0;
  const priceUsd = payable && p.accepts[0]?.amount ? Number(p.accepts[0].amount) / 1e6 : p.free ? 0 : null;
  // Over-cap is NOT a rejection. It is real, payable, and simply too expensive for this run — so it is
  // parked on the checklist with its price, not dropped on the floor.
  const overCap = priceUsd != null && priceUsd > Number(CAP);
  const status = payable || p.free ? (overCap ? "deferred-over-cap" : "probed") : "rejected";
  mark(r, { probe: { status: p.status, accepts: p.accepts, free: p.free, error: p.error }, payable, priceUsd, status,
    notes: status === "rejected" ? `not payment-or-nothing (${p.status || p.error})` : overCap ? `$${priceUsd} > cap $${CAP} — revisit with a higher cap` : "" });
  console.log(`  ${status.padEnd(18)} ${priceUsd != null ? ("$" + priceUsd).padEnd(9) : "".padEnd(9)} ${r.url.slice(0, 66)}`);
  await new Promise((x) => setTimeout(x, 300));
}

// ── Phase A2: enrich — real description, taxonomy placement, valid request body ────────────────
const taxonomy = readFileSync(join(__dir, "taxonomy.txt"), "utf8").trim();
const liveAssets = await buildAssetsDoc();
const ENRICHABLE = new Set(["probed", "paid"]);
const needEnrich = rows.filter((r) => ENRICHABLE.has(r.status) && !r.enriched);
if (needEnrich.length) {
  console.log(`\n── Phase A2: enriching ${needEnrich.length} via claude -p (${MODEL}) · ${liveAssets} live asset(s) ──`);
  for (let i = 0; i < needEnrich.length; i += 10) {
    const chunk = needEnrich.slice(i, i + 10);
    const got = enrich(chunk, taxonomy);
    for (const r of chunk) {
      const e = got.get(r.url);
      if (!e) { console.log(`  (no enrichment) ${r.url.slice(0, 66)}`); continue; }
      const valid = taxonomy.includes(`${e.category}/${e.subcategory}`);
      mark(r, {
        enriched: {
          description: e.description || r.spec?.summary || "",
          category: valid ? e.category : null, subcategory: valid ? e.subcategory : null,
          // These were previously dropped on the floor here, so every staged entry shipped tags:[] and a
          // defaulted text/text modality regardless of what the model actually returned.
          tags: Array.isArray(e.tags) ? e.tags : [],
          modalityIn: Array.isArray(e.modalityIn) ? e.modalityIn : [],
          modalityOut: Array.isArray(e.modalityOut) ? e.modalityOut : [],
          kind: e.kind === "model" ? "model" : "api",
          sampleBody: e.sampleBody ?? null, reason: e.reason || "",
        },
        enrichedFromSpec: !!r.spec?.inputSchema,
        // An endpoint needing another call's artifact cannot be blind-paid. Park it, don't burn money.
        status: e.needsInput ? "needs-input" : r.status,
        notes: e.needsInput ? `needs an artifact from another endpoint: ${e.reason || "?"}` : r.notes,
      });
      console.log(`  ${(valid ? e.category + "/" + e.subcategory : "!! INVALID TAXONOMY").padEnd(38)} ${e.needsInput ? "needs-input" : "ready"}  ${r.name}`);
    }
  }
} else console.log("\n── Phase A2: enrichment — nothing to do (resumed) ──");

// ── Phase B: ONE paid call each, money-safe, resumable ─────────────────────────────────────────
if (PAY) {
  const needPay = rows.filter((r) => r.status === "probed");
  console.log(`\n── Phase B: paying ${needPay.length} (requireChallenge, cap=$${CAP}) ──`);
  mkdirSync(join(DISCOVERY, "artifacts"), { recursive: true });
  for (const r of needPay) {
    let stdout = "";
    const artifact = join(DISCOVERY, "artifacts", `${slug(r.key)}.json`);
    try {
      // Pay with the SYNTHESISED body, never `{}` — an empty body buys a 400 (proved: $0.01 wasted).
      const args = [QA_PAY, `--url=${r.url}`, `--method=${r.method}`, `--cap=${CAP}`, `--save=${artifact}`];
      if (r.enriched?.sampleBody) args.push(`--body=${JSON.stringify(r.enriched.sampleBody)}`);
      stdout = execFileSync("node", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 180000, encoding: "utf8" });
    } catch (e) { stdout = String(e.stdout || ""); }
    // qa-pay prints the RESULT envelope to stdout; --save writes only the provider's response body.
    let meta = {}; try { meta = JSON.parse((stdout.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { /* ignore */ }
    const responseBody = readJson(artifact);
    const a = { classification: meta.classification || "no-result", costUsd: meta.costUsd ?? 0, httpStatus: meta.status, responseBody };
    const over = a.classification === "over-cap" || a.classification === "budget-exhausted";
    mark(r, {
      pay: { classification: a.classification, costUsd: a.costUsd ?? 0, httpStatus: a.httpStatus, responseBody: a.responseBody },
      status: over ? "deferred-over-cap" : "paid",
      notes: over ? `${a.classification} at cap $${CAP} — revisit` : "",
    });
    console.log(`  ${String(a.classification).padEnd(14)} http=${String(a.httpStatus ?? "?").padEnd(4)} $${(a.costUsd ?? 0).toFixed(4)}  ${r.name}`);
  }
} else {
  console.log(`\n── Phase B: skipped (no --pay). ${rows.filter((r) => r.status === "probed").length} endpoint(s) ready to pay.`);
}

const stageable = rows.filter((r) => r.status === "paid" || (!PAY && r.status === "probed"));
const rejected = rows.filter((r) => r.status === "rejected");
const deferred = rows.filter((r) => r.status === "deferred-over-cap");
// Every row must be in exactly ONE terminal-or-pending state, or the "nothing was lost" assertion is
// meaningless. `applied` (already written) and `needs-input` (parked, awaiting an artifact) are terminal
// too — omitting them made a resumed run report balances:NO even though nothing had gone missing.
const applied = rows.filter((r) => r.status === "applied");
const needsInput = rows.filter((r) => r.status === "needs-input");

// ── Phase C: stage proposed curation entries ───────────────────────────────────────────────────
// One entry per endpoint. NEVER merged into an existing service — see the header note on §5.5A/B.
// Build entries in the EXACT shape curation/<subcat>.json uses. Verified field-by-field against
// curation/video-generation.json: entry = {name, kind, provider, providerId, aka, description, tags,
// modality, backends, usage, status}; manual backend = {url, method, provider, providerId, amount,
// accepts, probe}; usage = {status, verifiedAt, resultPull, auth, callShape, inputExample, outputShape,
// quirks, needs, needsApproval, guide, costObservedUsd}.
// NOTE category/subcategory are NOT entry fields — they live on the FILE header, so the classification
// decides WHICH curation file an entry is written into.
const TODAY = new Date().toISOString().slice(0, 10);
const MODALITY = new Set(["text", "image", "video", "audio", "file"]);
const normModality = (a) => {
  const out = (a || []).map((m) => (m === "json" || m === "data" ? "text" : m)).filter((m) => MODALITY.has(m));
  return out.length ? [...new Set(out)] : ["text"];
};
const providerOf = (host) => {
  const bare = host.replace(/^(api|x402|www)\./, "").split(".").slice(0, -1).join(".") || host;
  return bare.split(/[-.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
};
/**
 * Quirks are OBSERVED facts, not invented ones — so they are derived from what we actually saw, and an
 * endpoint with nothing unusual correctly gets an empty list. Four real signals:
 *   • the provider's own spec stating a precondition ("must have been uploaded via … first")
 *   • a payment that succeeded while the call did not (charge-then-error — the trap that costs money)
 *   • a response carrying a job id (it is async; the result needs polling)
 *   • an input we could not satisfy, recorded with the field that blocked it
 */
function deriveQuirks(r) {
  const q = [];
  const sum = r.spec?.summary || "";
  const pre = sum.match(/[^.]*\b(must (?:have been|be)|requires?|only works?|first)\b[^.]*\./i);
  if (pre) q.push(pre[0].trim());
  const http = r.pay?.httpStatus ?? null;
  if (r.pay?.costUsd > 0 && http != null && http >= 400) {
    q.push(`CHARGE-THEN-ERROR: payment settled ($${r.pay.costUsd}) but the call returned HTTP ${http} — a bad request still costs money here.`);
  }
  const body = r.pay?.responseBody;
  if (body && typeof body === "object" && ("jobId" in body || "job_id" in body || "taskId" in body)) {
    q.push("Async: the paid POST returns a job id, not the result — poll for completion.");
  }
  if (r.status === "needs-input" && r.enriched?.reason) q.push(`Needs an input we cannot synthesise: ${r.enriched.reason}`);
  return [...new Set(q)].slice(0, 6);
}

let staged = stageable.map((r) => {
  const host = hostOf(r.url);
  const provider = providerOf(host);
  const paidOk = r.pay && (r.pay.httpStatus ?? 0) < 400 && r.pay.classification === "ok-paid";
  const body = r.pay?.responseBody;
  return {
    name: r.name,
    kind: r.enriched?.kind === "model" ? "model" : "api",
    provider,
    providerId: slug(provider),
    aka: [slug(r.name), slug(`${host} ${new URL(r.url).pathname.split("/").pop() || ""}`)].filter((x, i, a) => x && a.indexOf(x) === i),
    description: r.enriched?.description || r.spec?.summary || "",
    tags: (r.enriched?.tags || []).slice(0, 6),
    // Registry modality vocabulary is text|image|video|audio|file. Models sometimes answer "json"/"data";
    // normalise rather than letting a foreign token into the catalog.
    modality: { input: normModality(r.enriched?.modalityIn), output: normModality(r.enriched?.modalityOut) },
    backends: [{
      url: r.url,
      method: r.method,
      provider,
      providerId: slug(provider),
      amount: r.priceUsd,
      accepts: r.probe?.accepts || [],   // §5.5C — captured from the LIVE 402, never backfilled
      probe: { status: r.probe?.status ?? null, method: r.method, payable: !!r.payable, checkedAt: new Date().toISOString() },
      ...(r.spec?.inputSchema ? { inputSchema: r.spec.inputSchema } : {}),
      ...(r.spec?.outputSchema ? { outputSchema: r.spec.outputSchema } : {}),
    }],
    usage: {
      status: paidOk ? "verified" : r.pay ? "needs-review" : "untested",
      verifiedAt: r.pay ? TODAY : null,
      resultPull: paidOk && body && typeof body === "object" && ("jobId" in body || "id" in body) ? "poll" : "sync",
      auth: "none",
      callShape: `${r.method} ${r.url}${r.enriched?.sampleBody ? ` with JSON body ${JSON.stringify(r.enriched.sampleBody)}` : ""}`,
      inputExample: r.enriched?.sampleBody ?? null,
      outputShape: paidOk && body ? JSON.stringify(body).slice(0, 400) : "",
      quirks: deriveQuirks(r),
      needs: [],
      needsApproval: false,              // §5.5D — outward/irreversible is a human call, never guessed
      guide: r.spec?.summary || r.enriched?.description || "",
      costObservedUsd: r.pay?.costUsd ?? null,
    },
    status: "active",
    _sourceKey: r.key,                   // provenance + the URL identity that keeps this untangled
    _targetSubcat: r.enriched?.subcategory || null,
  };
});

// Assert every row sits in a KNOWN state rather than summing a hand-picked subset — enumerating buckets
// meant any state I forgot (named, probed-but-unpaid) looked like a lost endpoint.
const KNOWN_STATES = new Set(["todo", "named", "probed", "paid", "staged", "applied", "rejected", "deferred-over-cap", "needs-input"]);
const unknownState = rows.filter((r) => !KNOWN_STATES.has(r.status));
const accountedFor = rows.length - unknownState.length;
const stateMix = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

// ── §5.5B guard: slug(name) collisions are FATAL, never silent ─────────────────────────────────
const existing = SUBCAT ? readJson(join(CURATION, `${SUBCAT}.json`)) : null;
const existingSlugs = new Map((existing?.entries || []).map((e) => [slug(e.name), e.name]));
const collisions = [];
const batchSlugs = new Map();
for (const e of staged) {
  const s = slug(e.name);
  if (existingSlugs.has(s)) collisions.push(`"${e.name}" collides with EXISTING entry "${existingSlugs.get(s)}"`);
  if (batchSlugs.has(s)) collisions.push(`"${e.name}" collides with "${batchSlugs.get(s)}" in this same batch`);
  batchSlugs.set(s, e.name);
}

mkdirSync(STAGING, { recursive: true });
const stampFile = join(STAGING, `batch-${BATCH}-${Date.now()}.json`);
writeFileSync(stampFile, JSON.stringify({
  batch: BATCH, subcat: SUBCAT || null, generatedAt: new Date().toISOString(),
  accounting: { targets: targets.length, staged: staged.length, applied: applied.length, needsInput: needsInput.length, rejected: rejected.length, deferred: deferred.length, stateMix, balances: accountedFor === rows.length },
  collisions, rejected: rejected.map((r) => ({ url: r.url, notes: r.notes })), deferred: deferred.map((r) => ({ url: r.url, priceUsd: r.priceUsd, notes: r.notes })), entries: staged,
}, null, 2));

console.log(`\n── Phase C: staged ──`);
console.log(`  targets ${targets.length} → ${Object.entries(stateMix).map(([k, v]) => `${k} ${v}`).join(" · ")}  →  every row accounted for: ${accountedFor === rows.length ? "yes" : `NO — ${unknownState.length} in an unknown state`}`);
console.log(`  staging file: ${stampFile.replace(ROOT + "/", "")}`);
if (collisions.length) { console.log(`\n  ⚠️  ${collisions.length} NAME COLLISION(S) — must be resolved before --apply:`); for (const c of collisions.slice(0, 8)) console.log(`      ${c}`); }

// ── Phase D: apply, additively, with a hard integrity assertion ────────────────────────────────
if (APPLY) {
  // With --subcat, apply ONLY the entries classified into it — never sweep a differently-classified
  // capability into the file just because it shared a batch. That is how services get tangled.
  if (SUBCAT) {
    const off = staged.filter((e) => e._targetSubcat && e._targetSubcat !== SUBCAT);
    if (off.length) console.log(`\n  holding back ${off.length} entr(ies) classified elsewhere: ${[...new Set(off.map((e) => e._targetSubcat))].join(", ")}`);
    staged = staged.filter((e) => e._targetSubcat === SUBCAT);
    if (!staged.length) { console.error(`\nnothing in this batch is classified as ${SUBCAT}`); process.exit(1); }
  }
  const targetSubcats = [...new Set(staged.map((e) => e._targetSubcat).filter(Boolean))];
  const unclassified = staged.filter((e) => !e._targetSubcat).length;
  if (!SUBCAT && targetSubcats.length !== 1) {
    console.error(`\n--apply needs --subcat=<slug>: this batch classifies into ${targetSubcats.length} subcategories` +
      `${unclassified ? ` (+${unclassified} unclassified)` : ""} — ${targetSubcats.join(", ")}`);
    console.error("Split the batch or pass --subcat explicitly. Writing mixed capabilities into one file is how services get tangled.");
    process.exit(1);
  }
  if (unclassified) { console.error(`\nREFUSING: ${unclassified} entr(ies) have no subcategory — placement must be known, not guessed.`); process.exit(1); }
  const SUB = SUBCAT || targetSubcats[0];
  if (collisions.length) { console.error("\nREFUSING to apply: unresolved name collisions would silently drop entries (§5.5B)."); process.exit(1); }
  if (staged.some((e) => !e.name)) { console.error("\nREFUSING to apply: some entries are unnamed."); process.exit(1); }
  const path = join(CURATION, `${SUB}.json`);
  const before = readJson(path);
  if (!before) { console.error(`\nno curation file at ${path}`); process.exit(1); }
  const originalJson = JSON.stringify(before.entries);

  // strip our internal bookkeeping keys before they touch curation
  const clean = staged.map(({ _sourceKey, _targetSubcat, ...e }) => e);
  const after = { ...before, entries: [...before.entries, ...clean] };
  writeFileSync(path, JSON.stringify(after, null, 2));

  // Integrity: every pre-existing entry must be byte-identical. Restore + abort if not.
  const reread = readJson(path);
  const keptJson = JSON.stringify((reread.entries || []).slice(0, before.entries.length));
  if (keptJson !== originalJson) {
    writeFileSync(path, JSON.stringify(before, null, 2));
    console.error("\nINTEGRITY CHECK FAILED — existing entries changed. File restored, nothing added.");
    process.exit(1);
  }
  console.log(`\n── Phase D: applied ──`);
  console.log(`  ${staged.length} entries appended to curation/${SUB}.json`);
  console.log(`  ${before.entries.length} pre-existing entries verified byte-identical`);
  // Mark ONLY what was actually written. Iterating `stageable` here would flag held-back entries
  // (classified into a different subcategory) as applied, so they would never be written anywhere and
  // would quietly vanish — the same silent-drop class §5.5B warns about, one layer up.
  const appliedKeys = new Set(staged.map((e) => e._sourceKey));
  for (const r of stageable) if (appliedKeys.has(r.key)) mark(r, { status: "applied", subcat: SUB });
  console.log(`\n  next:  node scripts/registry/curate.mjs --subcat=${SUB}`);
  console.log(`         node scripts/registry/verify-drift.mjs && node scripts/registry/verify-no-tangle.mjs`);
} else {
  console.log(`\n  (staging only — nothing written to curation/. Add --apply --subcat=<slug> when the staged file looks right.)`);
}

// ── Provenance the owner must classify (§5.5D — never guessed here) ────────────────────────────
const hosts = [...new Set(staged.map((e) => hostOf(e.backends[0].url)))];
if (hosts.length) {
  console.log(`\n  hosts in this batch — curate.mjs will tag team/firstParty where it knows them;`);
  console.log(`  anything it leaves untagged is for you to classify (§5.5D: don't guess owner vs reseller):`);
  for (const h of hosts) console.log(`    ${h}`);
}
