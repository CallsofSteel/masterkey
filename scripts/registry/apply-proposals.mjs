#!/usr/bin/env node
// Masterkey — the SERIAL, deterministic write rail for agent-in-the-loop indexing.
//
// Parallel agents (Agent tool / Workflow) each research + pay-verify ONE endpoint and drop a proposal
// JSON in data/registry/discovery/proposals/. This script is the ONLY thing that mutates the registry, and
// it does so ADDITIVELY and provably:
//   • only entries with decision:"verified" are applied (deferred/untested/rejected stay parked);
//   • an entry missing a required field (name/description/accepts/amount/usage) is REFUSED, never shipped;
//   • slug(name) collisions (vs the existing file AND within this batch) are FATAL (§5.5B);
//   • entries are grouped by targetSubcat and appended to curation/<subcat>.json — never merged into an
//     existing service (a service-vs-backend merge is a human call; mergeCandidate is only reported);
//   • after writing, EVERY pre-existing entry is asserted byte-identical; on any drift the file is
//     restored and the run aborts.
// It does NOT run curate.mjs — that stays a separate, deliberate step (printed at the end).
//
// Flags: --dir=<proposals dir>  --file=<one proposal>  --subcat=<only this subcat>  --apply (write; default DRY)

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const CURATION = join(__dir, "curation");
const PROPOSALS = join(ROOT, "data/registry/discovery/proposals");
const PROGRESS = join(ROOT, "data/registry/indexing-progress.jsonl"); // durable, committed, append-only
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
function appendProgress(rows) { if (rows?.length) appendFileSync(PROGRESS, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
function deferStatus(reason) {
  const r = (reason || "").toLowerCase();
  if (/alias|duplicate/.test(r)) return "duplicate";                       // same model+provider as an existing entry
  if (/prepaid|top.?up|balance/.test(r)) return "deferred-prepaid";       // won't fit per-call model — don't revisit for cap
  if (/over.?cap|exceeds|> \$|budget/.test(r)) return "deferred-over-cap";
  if (/free/.test(r)) return "deferred-free-convention";
  if (/charge|error|http 4|http 5|400|402|500|502|guessed/.test(r)) return "deferred-charge-then-error";
  return "deferred-needs-input";
}
const today = () => new Date().toISOString().slice(0, 10);

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const has = (k) => argv.includes(`--${k}`);
const DIR = arg("dir", PROPOSALS);
const FILE = arg("file", "");
const ONLY = arg("subcat", "");
const APPLY = has("apply");

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// A proposal is shippable only if it is decision:"verified" AND carries every field an existing entry has.
function validate(p, src) {
  const errs = [];
  if (p?.decision !== "verified") return { skip: `decision=${p?.decision || "?"}` };
  const e = p.entry;
  if (!e) return { errs: [`${src}: no entry`] };
  if (!e.name) errs.push(`${src}: missing name`);
  if (!e.description) errs.push(`${src}: missing description`);
  if (!e.provider) errs.push(`${src}: missing provider`);
  if (!Array.isArray(e.tags) || !e.tags.length) errs.push(`${src}: empty tags`);
  // Registry convention: a no-input endpoint carries input ["text"] (not []); a data endpoint outputs ["json"].
  if (e.modality) {
    if (!e.modality.input?.length) e.modality.input = ["text"];
    if (!e.modality.output?.length) e.modality.output = ["json"];
  }
  if (!e.modality?.input?.length || !e.modality?.output?.length) errs.push(`${src}: incomplete modality`);
  // Coerce a stringified numeric amount (agents sometimes emit "0.002") to a real Number so it survives
  // into curation — a string amount passes the null check but crashes curate.mjs's fmtAmt (a.toFixed).
  for (const bk of e.backends || []) {
    if (typeof bk.amount === "string" && bk.amount.trim() !== "" && !Number.isNaN(Number(bk.amount))) bk.amount = Number(bk.amount);
  }
  const b = e.backends?.[0];
  if (!b) errs.push(`${src}: no backend`);
  else {
    if (!b.url || !b.method) errs.push(`${src}: backend missing url/method`);
    if (b.amount == null || typeof b.amount !== "number") errs.push(`${src}: backend missing/invalid amount (price)`);
    // §5.5C: a PAYABLE backend must carry accepts from the live 402. A FREE backend (amount 0, free 2xx)
    // legitimately has none (matches existing free entries e.g. StableAnalytics).
    if (b.amount > 0 && (!Array.isArray(b.accepts) || !b.accepts.length)) errs.push(`${src}: payable backend missing accepts (§5.5C)`);
    // Free backend (amount 0, no accepts): mark protocols:["free"] so curate doesn't stamp x402 (which
    // verify-no-tangle would flag as served-but-unpayable). Owner rule: "just note free", never a $0 accept.
    if ((b.amount === 0 || b.amount == null) && (!b.accepts || !b.accepts.length)) b.protocols = ["free"];
  }
  const u = e.usage;
  if (!u) errs.push(`${src}: no usage block`);
  else {
    if (u.status !== "verified") errs.push(`${src}: usage.status=${u.status} (only verified applies here)`);
    if (!u.callShape) errs.push(`${src}: usage missing callShape`);
    if (!u.guide) errs.push(`${src}: usage missing guide`);
    if (u.costObservedUsd == null) errs.push(`${src}: usage missing costObservedUsd`);
  }
  if (!p.targetSubcat) errs.push(`${src}: no targetSubcat`);
  // A verified+complete proposal classified into a NOT-YET-EXISTING subcat is HELD (needs-new-subcat),
  // not a batch-fatal error — one such proposal shouldn't block the rest of the batch. Record + revisit.
  if (p.targetSubcat && !errs.length && !existsSync(join(CURATION, `${p.targetSubcat}.json`))) {
    return { skip: `subcat "${p.targetSubcat}" has no curation file — held (needs-new-subcat)`, newSubcat: true, url: e.backends?.[0]?.url, subcat: p.targetSubcat };
  }
  return { errs, entry: e, subcat: p.targetSubcat, merge: p.mergeCandidate || null };
}

// ── Load proposals ──
const files = FILE ? [FILE] : (existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f)) : []);
if (!files.length) { console.error(`no proposals in ${FILE || DIR}`); process.exit(1); }

// A model+operation is ONE service; each provider offering it is a backend (§5.5A). A proposal with a
// mergeCandidate is a NEW BACKEND for an existing service (its own url/price/accepts/schema — never a shared
// path, that's the tangle). Resolve the target service by name across ALL curation files.
function resolveTarget(name) {
  const want = slug(name);
  for (const f of readdirSync(CURATION).filter((x) => x.endsWith(".json"))) {
    const j = readJson(join(CURATION, f)); if (!j?.entries) continue;
    const idx = j.entries.findIndex((e) => slug(e.name) === want);
    if (idx >= 0) return { file: f, subcat: f.replace(/\.json$/, ""), idx, entry: j.entries[idx] };
  }
  return null;
}

const ready = []; const skipped = []; const errors = []; const folds = []; const unresolved = [];
const deferredRows = []; const heldRows = []; const newSubcatRows = [];  // durable progress records
for (const f of files) {
  const p = readJson(f); const src = f.replace(ROOT + "/", "");
  const v = validate(p, src);
  // Record deferred proposals durably so the backlog is never lost.
  if (p?.decision === "deferred") { const u = p.entry?.backends?.[0]?.url; if (u) deferredRows.push({ ts: today(), batch: "apply", url: u, host: hostOf(u), status: deferStatus(p.reason), subcat: p.targetSubcat || undefined, note: p.reason || undefined }); }
  if (v.skip) { skipped.push(`${src} — ${v.skip}`); if (v.newSubcat && v.url) newSubcatRows.push({ ts: today(), batch: "apply", url: v.url, host: hostOf(v.url), status: "deferred-needs-subcat", subcat: v.subcat, note: "classified into a subcat with no curation file — create it to index" }); continue; }
  if (v.errs?.length) { errors.push(...v.errs); continue; }
  if (ONLY && v.subcat !== ONLY) { skipped.push(`${src} — subcat ${v.subcat} (filtered to ${ONLY})`); continue; }
  if (v.merge) {
    // Same model/op as an existing service → fold this provider in as a NEW BACKEND (§5.5A).
    const t = resolveTarget(v.merge);
    const backend = v.entry.backends?.[0];
    if (!t) { unresolved.push(`${src} — merge target "${v.merge}" not found in any curation file (naming mismatch?) — HELD, not applied`); if (backend?.url) heldRows.push({ ts: today(), batch: "apply", url: backend.url, host: hostOf(backend.url), status: "held-unresolved-merge", note: `merge target "${v.merge}" not found` }); continue; }
    if (!backend?.url) { errors.push(`${src}: merge proposal has no backend to fold`); continue; }
    if ((t.entry.backends || []).some((b) => b.url === backend.url)) { skipped.push(`${src} — backend ${backend.url} already on "${t.entry.name}"`); continue; }
    folds.push({ src, targetFile: t.file, targetSlug: slug(t.entry.name), targetName: t.entry.name, backend, providerLabel: v.entry.provider, costUsd: v.entry.usage?.costObservedUsd });
    continue;
  }
  ready.push({ entry: v.entry, subcat: v.subcat, src });
}

console.log(`proposals: ${files.length} · new services: ${ready.length} · backend-folds: ${folds.length} · unresolved-merge: ${unresolved.length} · skipped: ${skipped.length} · field-errors: ${errors.length}`);
skipped.forEach((s) => console.log(`  · skip  ${s}`));
unresolved.forEach((s) => console.log(`  · HELD  ${s}`));
if (errors.length) { console.error(`\n✗ REFUSING — incomplete entries (an empty field is a failure per the criteria):`); errors.forEach((e) => console.error(`    ${e}`)); process.exit(1); }
if (folds.length) { console.log(`\n  🔗 BACKEND FOLDS (add a provider to an existing service, §5.5A):`); folds.forEach((m) => console.log(`      "${m.targetName}"  +backend  ${m.providerLabel} (${m.backend.url})`)); }
// Record parked outcomes (deferred/held) on --apply even when nothing gets written, so a fully-deferred
// batch (e.g. a prepaid provider) is still captured in the ledger rather than left as pending "probed".
if (APPLY && (deferredRows.length || heldRows.length || newSubcatRows.length)) appendProgress([...deferredRows, ...heldRows, ...newSubcatRows]);
if (!ready.length && !folds.length) { console.log("\nnothing to apply (parked outcomes recorded)."); process.exit(0); }

// ── Plan per curation file: new-service appends + backend-folds. Collision-check names. ──
const byFile = new Map();  // file → { subcat, appends:[entry], folds:[{targetSlug,backend}] }
const plan = (file, subcat) => { if (!byFile.has(file)) byFile.set(file, { subcat, appends: [], folds: [] }); return byFile.get(file); };
for (const r of ready) plan(`${r.subcat}.json`, r.subcat).appends.push(r.entry);
for (const m of folds) plan(m.targetFile, m.targetFile.replace(/\.json$/, "")).folds.push({ targetSlug: m.targetSlug, backend: m.backend });

const touched = [];
for (const [file, { subcat, appends, folds: ff }] of byFile) {
  const path = join(CURATION, file);
  const before = readJson(path);
  const original = before.entries || [];
  const existingSlugs = new Map(original.map((e) => [slug(e.name), e.name]));
  const seen = new Map(); const collisions = [];
  for (const e of appends) {
    const s = slug(e.name);
    if (existingSlugs.has(s)) collisions.push(`"${e.name}" collides with EXISTING "${existingSlugs.get(s)}"`);
    if (seen.has(s)) collisions.push(`"${e.name}" collides with "${seen.get(s)}" in this batch`);
    seen.set(s, e.name);
  }
  if (collisions.length) { console.error(`\n✗ ${subcat}: name collisions (§5.5B) — resolve first:`); collisions.forEach((c) => console.error(`    ${c}`)); process.exit(1); }

  // Build the intended `after` array: fold targets get appended backends; then new services at the tail.
  const foldBySlug = new Map(); for (const x of ff) { if (!foldBySlug.has(x.targetSlug)) foldBySlug.set(x.targetSlug, []); foldBySlug.get(x.targetSlug).push(x.backend); }
  const after = original.map((e) => {
    const add = foldBySlug.get(slug(e.name));
    return add ? { ...e, backends: [...(e.backends || []), ...add] } : e;
  }).concat(appends);

  const foldNames = ff.map((x) => x.targetSlug);
  console.log(`\n${file}: +${appends.length} service(s)${appends.length ? " → " + appends.map((e) => `"${e.name}"`).join(", ") : ""}${ff.length ? ` · +${ff.length} backend(s) on ${[...new Set(foldNames)].join(", ")}` : ""}`);
  if (!APPLY) continue;

  writeFileSync(path, JSON.stringify({ ...before, entries: after }, null, 2));
  // ADDITIVITY ASSERT: every original entry unchanged, EXCEPT fold targets which only GAINED backends at the tail.
  const reread = readJson(path).entries || [];
  let ok = reread.length === original.length + appends.length;
  for (let i = 0; ok && i < original.length; i++) {
    const add = foldBySlug.get(slug(original[i].name));
    if (add) {
      const back = reread[i].backends || [];
      const prefixSame = JSON.stringify(back.slice(0, (original[i].backends || []).length)) === JSON.stringify(original[i].backends || []);
      const restSame = JSON.stringify({ ...reread[i], backends: undefined }) === JSON.stringify({ ...original[i], backends: undefined });
      const grewByN = back.length === (original[i].backends || []).length + add.length;
      ok = prefixSame && restSame && grewByN;
    } else {
      ok = JSON.stringify(reread[i]) === JSON.stringify(original[i]);
    }
  }
  if (!ok) { writeFileSync(path, JSON.stringify(before, null, 2)); console.error(`\n✗ INTEGRITY CHECK FAILED on ${file} — a pre-existing entry changed beyond an appended backend. Restored, aborted.`); process.exit(1); }
  console.log(`  ✓ additive: ${original.length} pre-existing entries intact (fold targets only gained backends)`);
  touched.push(subcat);
}

if (!APPLY) { console.log(`\n(DRY RUN — add --apply to write. Then: curate + verify each touched subcat.)`); process.exit(0); }

// Durably record every outcome (append-only; latest-per-URL wins in progress-summary.mjs).
appendProgress([
  ...ready.map((r) => ({ ts: today(), batch: "apply", url: r.entry.backends[0].url, host: hostOf(r.entry.backends[0].url), status: "indexed", service: r.entry.name, subcat: r.subcat, costUsd: r.entry.usage?.costObservedUsd ?? undefined })),
  ...folds.map((m) => ({ ts: today(), batch: "apply", url: m.backend.url, host: hostOf(m.backend.url), status: "folded", service: m.targetName, costUsd: m.costUsd ?? undefined, note: `backend on ${m.targetName}` })),
]);  // deferred/held already recorded above

console.log(`\n── applied. Next (per touched subcat): ──`);
for (const s of [...new Set(touched)]) console.log(`  node scripts/registry/curate.mjs --subcat=${s}`);
console.log(`  node scripts/registry/verify-drift.mjs && node scripts/registry/verify-no-tangle.mjs && node scripts/registry/verify-bundle-pins.mjs`);
