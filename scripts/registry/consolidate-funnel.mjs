#!/usr/bin/env node
// Masterkey — consolidate every discovery sweep into ONE ordered, batched worklist.
//
// Flags: --batch-size=N   --host=<substring>
//
// This is the LAST free step. It turns ~40k raw leads from five sources into a deduped, prioritised,
// batched checklist that the existing pay-test harness (qa-pay / qa-batch.workflow / qa-next) can chew
// through a group at a time. It writes NOTHING into the registry.
//
// ════════ THE THREE GUARANTEES ════════
//
// 1. ADDITIVE — it cannot overwrite anything.
//    Same structural guard as discover-new.mjs: assertWritable() refuses every registry path, and also
//    the live qa-checklist.json. The only output is a new file under data/registry/discovery/.
//
// 2. NO TANGLING — keyed by URL, never by name.
//    MASTERKEY_HANDOFF §5.5B documents the trap that bit the 2026-06-24 BlockRun batch: when a bulk
//    script dedupes by `slug(name)`, two DISTINCT operations deriving the SAME name silently collapse —
//    the second is LOST, not visibly merged. qa-checklist keys on `serviceId#N` (serviceId = slug(name)),
//    so that failure mode is live in the existing format.
//    Here identity is the normalized URL, unique per endpoint by construction. Proposed names are
//    computed too, but ONLY to REPORT collisions up front (`nameCollisions`) so a human resolves them
//    during curation instead of an endpoint quietly disappearing.
//
// 3. DONE ONCE — every input is accounted for.
//    Each source record lands in exactly one bucket (new / known / hidden / unusable / preview /
//    mpp-only / apify / unparseable) and the totals are asserted to balance. §5.5B: "after ANY batch,
//    assert every source endpoint landed."
//
// ════════ WHAT IT DELIBERATELY DOES NOT DO ════════
// It does not decide service-vs-backend modelling. §5.5A: a gateway serving an existing capability is a
// BACKEND of that service, never a new "X (via Sponge)" service. §5.5B: two endpoints are the same
// service only if the request/response CONTRACT matches — which cannot be known without calling them.
// That judgement belongs to pay-test + curation. This script only says: "here is a coherent group of
// endpoints from one host, in priority order, none of which we already have."

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { teamForHost, TEAM_TIER } from "./teams.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const BY_SUBCAT = join(ROOT, "data/registry/by-subcat");
const CURATION = join(__dir, "curation");
const CANDIDATES = join(__dir, "candidates");
const DISCOVERY = join(ROOT, "data/registry/discovery");

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const BATCH_SIZE = Number(arg("batch-size", "40"));
const HOST_FILTER = (arg("host", "") || "").toLowerCase();

// ── Write guard (same policy as discover-new.mjs, plus the live checklist) ─────────────────────
const PROTECTED = [
  BY_SUBCAT, CURATION, CANDIDATES,
  join(ROOT, "data/registry/index.json"),
  join(ROOT, "data/registry/meta.json"),
  join(ROOT, "data/registry/qa-checklist.json"),
];
function assertWritable(target) {
  const t = resolve(target);
  for (const p of PROTECTED) {
    if (t === resolve(p) || t.startsWith(resolve(p) + "/")) {
      throw new Error(`REFUSING TO WRITE inside a protected path: ${t}`);
    }
  }
  return t;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function norm(u) {
  if (!u || typeof u !== "string") return null;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(u.trim());
  if (!m) return null;
  let host = m[1].toLowerCase().split("@").pop();
  if (host.startsWith("www.")) host = host.slice(4);
  return host + ((m[2] || "/").replace(/\/+$/, "") || "/");
}
const hostOf = (k) => (k || "").split("/")[0];
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const UNUSABLE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/;
const PREVIEW = /-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app|^[a-z0-9]+-[a-z0-9]{9}-/;
const PLATFORM = /\.(vercel\.app|up\.railway\.app|workers\.dev|hf\.space|supabase\.co|onrender\.com|fly\.dev|netlify\.app|herokuapp\.com|trycloudflare\.com)$/;

// ── What we already have, in ANY state ─────────────────────────────────────────────────────────
function buildKnown() {
  const known = new Map();
  const vetted = new Set();
  const add = (u, why) => { const k = norm(u); if (k && !known.has(k)) known.set(k, why); };
  for (const f of existsSync(BY_SUBCAT) ? readdirSync(BY_SUBCAT).filter((x) => x.endsWith(".json")) : []) {
    for (const s of readJson(join(BY_SUBCAT, f)) || []) {
      const sh = s.status === "hidden";
      for (const t of [...(s.backends || []), ...(s.operations || [])]) {
        const dead = sh || t.status === "hidden";
        add(t.url, dead ? "hidden" : "known");
        if (!dead) { const k = norm(t.url); if (k) vetted.add(hostOf(k)); }
      }
    }
  }
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      const d = readJson(p);
      const ents = Array.isArray(d) ? d : d?.entries ?? d?.candidates ?? [];
      for (const s of ents) {
        if (!s || typeof s !== "object") continue;
        add(s.url, "known");
        for (const t of [...(s.backends || []), ...(s.operations || [])]) add(t.url, "known");
      }
    }
  };
  walk(CURATION); walk(CANDIDATES);
  return { known, vetted };
}

// ── Load every discovery report ────────────────────────────────────────────────────────────────
function loadSources() {
  const rows = [];
  if (!existsSync(DISCOVERY)) return rows;
  for (const f of readdirSync(DISCOVERY).filter((x) => x.endsWith(".json"))) {
    const d = readJson(join(DISCOVERY, f));
    if (!d) continue;
    if (d.byHost) {                       // discover-new.mjs report
      for (const list of Object.values(d.byHost)) for (const e of list) rows.push({ ...e, _from: f });
    }
    if (Array.isArray(d.endpoints)) {     // discover-agentcash report
      for (const e of d.endpoints) rows.push({ ...e, _from: f });
    }
  }
  return rows;
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
const { known, vetted } = buildKnown();
const raw = loadSources();
const reportCount = existsSync(DISCOVERY) ? readdirSync(DISCOVERY).filter((f) => f.endsWith(".json")).length : 0;
console.log(`loaded ${raw.length.toLocaleString()} endpoint records from ${reportCount} discovery report(s)`);
console.log(`registry known-set: ${known.size.toLocaleString()} URLs · ${vetted.size} hosts we already serve\n`);

const buckets = { new: [], known: 0, hidden: 0, unusable: 0, preview: 0, mppOnly: 0, apify: 0, unparseable: 0 };
const seen = new Map();

for (const r of raw) {
  const k = norm(r.url);
  if (!k) { buckets.unparseable++; continue; }
  const host = hostOf(k);
  if (HOST_FILTER && !host.includes(HOST_FILTER)) continue;

  if (seen.has(k)) { // fold a duplicate sighting; union provenance and fill gaps
    const prev = seen.get(k);
    prev.sources = [...new Set([...prev.sources, ...(r.sources || [])])];
    prev.traction ||= r.usage ?? null;
    prev.price ??= r.price ?? null;
    prev.description ||= r.description || "";
    // Richest-sighting-wins for the pay-relevant fields (bazaar carries these; agentcash doesn't) —
    // previously dropped, so the funnel had accepts:0%/schema:0% and every wave re-probed for them.
    prev.accepts ??= r.accepts ?? null;
    prev.bazaar ??= r.bazaar ?? null;
    prev.tags ??= r.tags ?? null;
    prev.quality ??= r.quality ?? null;
    prev.method ??= r.method ?? null;
    continue;
  }

  if (host === "api.apify.com" || host === "apify.com") { buckets.apify++; continue; }
  if (UNUSABLE.test(host)) { buckets.unusable++; continue; }
  if (PREVIEW.test(host)) { buckets.preview++; continue; }
  const protos = r.protocols;
  if (Array.isArray(protos) && protos.includes("mpp") && !protos.includes("x402")) { buckets.mppOnly++; continue; }
  const why = known.get(k);
  if (why === "hidden") { buckets.hidden++; continue; }
  if (why) { buckets.known++; continue; }

  const team = teamForHost(host);
  const tier = team && TEAM_TIER[team] ? TEAM_TIER[team] : PLATFORM.test(host) ? 4 : 3;
  const rec = {
    key: k,                                  // URL-keyed — immune to the slug(name) silent-drop trap
    url: r.url, host, method: r.method ?? null,
    name: r.name || "", description: r.description || "",
    price: r.price ?? null, authMode: r.authMode ?? null,
    protocols: protos ?? null,
    team: team ?? null, tier: `T${tier}`,
    vettedProvider: vetted.has(host),
    traction: r.usage ?? null,               // AgentCash resourceUsage — real paid demand
    // Pay-relevant enrichment from bazaar (CDP index) — lets the pre-filter skip probing + hands the agent
    // the documented call. Live 402 re-capture at index time stays authoritative (§5.5C, staleness).
    accepts: r.accepts ?? null,              // full x402 payment requirements (price/asset/network/payTo)
    bazaar: r.bazaar ?? null,                // info.input example + output.example + JSON schema
    tags: r.tags ?? null, quality: r.quality ?? null,
    sources: r.sources || [], foundIn: r._from,
    proposedName: r.name || "",              // collision REPORTING only, never identity
    status: "todo",
  };
  seen.set(k, rec);
  buckets.new.push(rec);
}

// ── §5.5B silent-drop guard: report name collisions BEFORE they reach curation ─────────────────
const byProposedSlug = new Map();
for (const r of buckets.new) {
  const s = slug(r.proposedName) || slug(r.key);
  if (!byProposedSlug.has(s)) byProposedSlug.set(s, []);
  byProposedSlug.get(s).push(r.key);
}
const nameCollisions = [...byProposedSlug.entries()].filter(([, v]) => v.length > 1);

// ── Accounting: every input must land somewhere ────────────────────────────────────────────────
const placed = buckets.new.length + buckets.known + buckets.hidden + buckets.unusable +
  buckets.preview + buckets.mppOnly + buckets.apify + buckets.unparseable;
const dupes = raw.length - placed;

// ── Priority: vetted provider → real traction → trust tier → host ──────────────────────────────
const tractionOf = (r) => (r.traction?.transactionCount ?? 0) + (r.traction?.volumeUsd ?? 0) * 10;
buckets.new.sort((a, b) =>
  (b.vettedProvider ? 1 : 0) - (a.vettedProvider ? 1 : 0) ||
  tractionOf(b) - tractionOf(a) ||
  Number(a.tier.slice(1)) - Number(b.tier.slice(1)) ||
  a.host.localeCompare(b.host));

// ── Batch BY HOST: one provider at a time keeps contracts coherent (§5.5A/B) ───────────────────
const hosts = new Map();
for (const r of buckets.new) { if (!hosts.has(r.host)) hosts.set(r.host, []); hosts.get(r.host).push(r); }
const batches = [];
let cur = { id: 1, hosts: [], endpoints: [] };
for (const [host, list] of hosts) {
  if (cur.endpoints.length && cur.endpoints.length + list.length > BATCH_SIZE) {
    batches.push(cur); cur = { id: batches.length + 1, hosts: [], endpoints: [] };
  }
  cur.hosts.push(host); cur.endpoints.push(...list);
}
if (cur.endpoints.length) batches.push(cur);

mkdirSync(DISCOVERY, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
const out = assertWritable(join(DISCOVERY, `funnel-${stamp}.json`));
writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  accounting: {
    inputRecords: raw.length, duplicateSightings: dupes,
    new: buckets.new.length, alreadyKnown: buckets.known, hiddenAlreadyRejected: buckets.hidden,
    unusable: buckets.unusable, previewDeploys: buckets.preview, mppOnly: buckets.mppOnly,
    apifyDynamic: buckets.apify, unparseable: buckets.unparseable, balances: dupes >= 0,
  },
  nameCollisions: nameCollisions.map(([s, keys]) => ({ proposedSlug: s, endpoints: keys })),
  batches: batches.map((b) => ({ id: b.id, hosts: b.hosts, count: b.endpoints.length, endpoints: b.endpoints })),
}, null, 2));

console.log("════════ ACCOUNTING (every input lands in exactly one bucket) ════════");
for (const [k, v] of Object.entries({
  "input records": raw.length, "duplicate sightings (folded)": dupes,
  "already in registry": buckets.known, "hidden (already rejected)": buckets.hidden,
  "unusable (localhost/private)": buckets.unusable, "preview deploys": buckets.preview,
  "mpp-only (unpayable)": buckets.mppOnly, "apify (dynamic)": buckets.apify,
  unparseable: buckets.unparseable,
})) console.log(`  ${k.padEnd(32)} ${String(v).padStart(8)}`);
console.log(`  ${"NEW → worklist".padEnd(32)} ${String(buckets.new.length).padStart(8)}`);
console.log(`  ${"balances".padEnd(32)} ${dupes >= 0 ? "yes" : "NO — INVESTIGATE"}`);

const vettedCount = buckets.new.filter((r) => r.vettedProvider).length;
const withTraction = buckets.new.filter((r) => (r.traction?.transactionCount ?? 0) > 0).length;
console.log(`\n  at providers we already serve : ${vettedCount}   <- batch 1 starts here`);
console.log(`  with REAL paid traction       : ${withTraction}`);
console.log(`  tier mix                      : ${["T1", "T2", "T3", "T4"].map((t) => `${t}=${buckets.new.filter((r) => r.tier === t).length}`).join("  ")}`);
console.log(`\n  batches of ~${BATCH_SIZE} (grouped by host): ${batches.length}`);
for (const b of batches.slice(0, 6)) {
  console.log(`    #${String(b.id).padStart(3)}  ${String(b.endpoints.length).padStart(4)} endpoints  ${b.hosts.slice(0, 3).join(", ")}${b.hosts.length > 3 ? ` +${b.hosts.length - 3} hosts` : ""}`);
}

if (nameCollisions.length) {
  console.log(`\n  ⚠️  ${nameCollisions.length} proposed-name collision(s) — §5.5B silent-drop risk.`);
  console.log(`      REPORTED, not merged. Give them distinct names during curation, or the second`);
  console.log(`      endpoint of each pair is silently lost by a slug(name) dedupe.`);
  for (const [s, keys] of nameCollisions.slice(0, 5)) console.log(`      ${s || "(empty)"}: ${keys.length} endpoints`);
}
console.log(`\n  worklist -> ${out.replace(ROOT + "/", "")}`);
console.log(`  Nothing in the registry or qa-checklist.json was modified.`);
