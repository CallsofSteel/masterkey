/**
 * apply-visibility.mjs — enforce the catalog visibility policy in the SOURCE (curation), durably.
 *
 * POLICY (what the agent / web app may see): expose ONLY services we have PROVEN work and that are
 * usable. Everything else stays in our data (track record) but is hidden — never served (registry.ts
 * + MCP strip status:"hidden"). Each hidden service gets a `hiddenReason` so we know WHY and never
 * re-test / re-pay it:
 *   serve  ⇐ has a VERIFIED active backend that is usable: selectable (valid payment.accepts) OR siwx OR free
 *   hidden ⇐ otherwise, with reason:
 *            mpp          – only MPP backends (paywithlocus / *.mpp.*) — not x402
 *            broken       – usage.status "broken" (charge-then-fail)
 *            dead         – every tested endpoint errored (called → error/nothing)
 *            over-cap     – live quote > ceiling (needs $ approval)
 *            needs-input  – needs a key / owned resource / unresolved template
 *            needs-review – transient host/5xx (re-test before relying)
 *            untested     – never verified working
 *
 * SIWX finalize: a VERIFIED service whose auth is siwx and that PAYS (usage.costObservedUsd > 0) but
 * has no parseable accepts (its 402 is a SIWX challenge) gets a synthetic Base/USDC selection accept
 * (amount = observed cost) written to SOURCE so the run engine's isPayable() can select it; Sponge
 * still does the real SIWX payment at call time. Tagged accepts[].source="siwx-verified-synthetic".
 *
 * Touches ONLY status / hiddenReason / (synth) accepts — never usage text / price / quirks.
 * Reads by-subcat (resolved view) + checklist (verified set); writes curation (+ candidates for synth).
 * Run curate.mjs afterwards.
 *
 * Usage: node scripts/registry/apply-visibility.mjs --subcat=<x> [--subcat=...] | --all  [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const BYSUB = join(ROOT, "data/registry/by-subcat");
const CUR = join(__dir, "curation");
const CAND = join(__dir, "candidates");
const CK = join(ROOT, "data/registry/qa-checklist.json");
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const getAll = (k) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.split("=")[1]);
const DRY = has("dry-run");
const NOW = new Date().toISOString();
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const ck = JSON.parse(readFileSync(CK, "utf8"));
const verifiedUrls = new Set(ck.endpoints.filter((e) => e.status === "verified").map((e) => e.url));
const epByService = {};
for (const e of ck.endpoints) (epByService[e.serviceId] ||= []).push(e.status);

const onlySubs = getAll("subcat");
const subs = has("all") ? readdirSync(CUR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : onlySubs;
if (!subs.length) { console.error("specify --subcat=<x> | --all"); process.exit(2); }

const isMpp = (u) => /paywithlocus|\.mpp\./.test(u || "");
const validAccepts = (acc) => Array.isArray(acc) && acc.length > 0 && acc.some((a) => a && a.amount && a.asset && /base|8453/.test(a.network || ""));

const tally = { serve: 0, mpp: 0, broken: 0, dead: 0, "over-cap": 0, "needs-input": 0, "needs-review": 0, untested: 0, siwxSynth: 0 };
const changes = [];

for (const sub of subs) {
  const bsPath = join(BYSUB, `${sub}.json`);
  const curPath = join(CUR, `${sub}.json`);
  if (!existsSync(bsPath) || !existsSync(curPath)) continue;
  const bs = JSON.parse(readFileSync(bsPath, "utf8"));
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  const candPath = join(CAND, `${sub}.json`);
  const cand = existsSync(candPath) ? JSON.parse(readFileSync(candPath, "utf8")) : null;
  const C = cand?.candidates || [];
  const bsById = new Map(bs.map((s) => [s.id, s]));
  let curChanged = false, candChanged = false;

  for (const e of cur.entries || []) {
    const id = slug(e.name); // MUST match curate.mjs (line ~111: id: slug(e.name)); e.id is ignored by curate
    const svc = bsById.get(id);
    if (!svc) continue;
    const active = (svc.backends || []).filter((b) => b && typeof b === "object" && b.status === "active");
    const eps = epByService[id] || [];
    const auth = svc.usage?.auth || "none";
    const cost = svc.usage?.costObservedUsd ?? 0;
    const usageStatus = svc.usage?.status || "untested"; // QA verdict = the authoritative working/not signal
    let selectable = active.some((b) => validAccepts(b.payment?.accepts));
    const mppAll = active.length > 0 && active.every((b) => isMpp(b.url));

    // SIWX finalize: VERIFIED + siwx + pays + not selectable → synth a Base/USDC selection accept to source
    // (the run engine's isPayable() needs accepts; Sponge still does the real SIWX payment at call time)
    if (!selectable && !mppAll && usageStatus === "verified" && auth === "siwx" && cost > 0) {
      const target = active.find((b) => verifiedUrls.has(b.url)) || active[0];
      if (target) {
      const amount = String(Math.max(1, Math.round(cost * 1e6)));
      const synth = [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount, source: "siwx-verified-synthetic" }];
      // write to source: matching candidate (by url) or manual curation backend object
      let wrote = false;
      for (const b of e.backends || []) {
        if (b && typeof b === "object" && b.url === target.url) { b.accepts = synth; b.probe = { ...(b.probe || {}), status: 402, payable: true, checkedAt: NOW }; wrote = true; curChanged = true; }
        else if (typeof b === "number" && C[b] && (C[b].url === target.url || C[b].key === target.url)) { C[b].accepts = synth; wrote = true; candChanged = true; }
      }
      if (wrote) { selectable = true; tally.siwxSynth++; changes.push(`  ~siwx-synth ${id} ($${cost} → ${amount} atomic USDC/base)`); }
      }
    }

    // classify — serve ONLY what QA proved working (usage.status==="verified"); record WHY for the rest
    let status, reason = null;
    if (mppAll) { status = "hidden"; reason = "mpp"; }
    else if (usageStatus === "verified") { status = "active"; }
    else if (usageStatus === "broken") { status = "hidden"; reason = "broken"; }
    else if (eps.length && eps.every((s) => s === "broken")) { status = "hidden"; reason = "dead"; }
    else if (eps.includes("over-cap")) { status = "hidden"; reason = "over-cap"; }
    else if (eps.includes("needs-input")) { status = "hidden"; reason = "needs-input"; }
    else if (eps.includes("needs-review")) { status = "hidden"; reason = "needs-review"; }
    else { status = "hidden"; reason = "untested"; }

    const before = `${e.status || "?"}/${e.hiddenReason || "-"}`;
    if (status === "active") { if (e.status !== "active" || e.hiddenReason) { e.status = "active"; delete e.hiddenReason; curChanged = true; changes.push(`  +serve  ${id}  (was ${before})`); } tally.serve++; }
    else { if (e.status !== "hidden" || e.hiddenReason !== reason) { e.status = "hidden"; e.hiddenReason = reason; curChanged = true; changes.push(`  -hide:${reason.padEnd(11)} ${id}  (was ${before})`); } tally[reason]++; }
  }

  if (!DRY) {
    if (curChanged) writeFileSync(curPath, JSON.stringify(cur, null, 2) + "\n");
    if (candChanged && cand) writeFileSync(candPath, JSON.stringify(cand, null, 2));
  }
}

console.log(`apply-visibility ${DRY ? "(DRY-RUN) " : ""}— subcats: ${subs.length}`);
console.log(`SERVE: ${tally.serve}   |   HIDDEN → mpp:${tally.mpp} broken:${tally.broken} dead:${tally.dead} over-cap:${tally["over-cap"]} needs-input:${tally["needs-input"]} needs-review:${tally["needs-review"]} untested:${tally.untested}   |   siwx-synth:${tally.siwxSynth}`);
if (changes.length) { console.log(`\nchanges (${changes.length}):`); changes.slice(0, 80).forEach((c) => console.log(c)); if (changes.length > 80) console.log(`  … +${changes.length - 80} more`); }
console.log(DRY ? "\n(dry-run — wrote nothing)" : "\nwrote curation (+candidates for synth). Run curate.mjs --subcat=<each> to apply.");
