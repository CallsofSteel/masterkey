/**
 * integrate-remediation.mjs — fold the verified per-provider remediation results into the curation source.
 *
 * Input: data/registry/_remediation-results.json (workflow output: per old service → {classification, services[]}).
 * For each result we REPLACE the old bundled curation entry with the new coherent op-services the workflow
 * verified. Backend payment `accepts` are looked up by URL from the existing by-subcat data (the workflow
 * didn't re-capture accepts). Anything we can't cleanly map is LOGGED, never silently dropped.
 *
 * Run: node scripts/registry/integrate-remediation.mjs            (dry-run: report only)
 *      node scripts/registry/integrate-remediation.mjs --apply    (write curation files)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const APPLY = process.argv.includes("--apply");
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const results = JSON.parse(readFileSync(join(ROOT, "data/registry/_remediation-results.json"), "utf8"));
const pending = JSON.parse(readFileSync(join(__dir, ".remediation-pending.json"), "utf8"));
const fileById = {}; for (const p of pending) fileById[p.id] = p.file;
// validation batch (address-validator, email-validator, background-removal, hunter-io) files:
fileById["address-validator"] ||= "address-validation.json";
fileById["email-validator"] ||= "address-validation.json";
fileById["background-removal"] ||= "background-removal.json";
fileById["hunter-io"] ||= "company-people-data.json";

// global backend index: url -> resolved backend (accepts/method/price/provider/firstParty/hosting)
const BYSUB = join(ROOT, "data/registry/by-subcat");
const beByUrl = {};
for (const f of readdirSync(BYSUB).filter((f) => f.endsWith(".json"))) {
  for (const s of JSON.parse(readFileSync(join(BYSUB, f), "utf8"))) {
    for (const b of s.backends || []) if (b && typeof b === "object" && b.url) beByUrl[b.url] = b;
  }
}

const issues = [];
const STATUS_MAP = { verified: ["active", undefined], "needs-input": ["hidden", "needs-input"], broken: ["hidden", "broken"], "over-cap": ["hidden", "over-cap"], "outward-unverified": ["hidden", "needs-review"] };
const isBrokenBe = (b) => /\b(broken|drop|hide|dead|settlement failed)\b/i.test(b.note || "");
const pollish = (q) => (q || []).some((x) => /\b(async|poll|202|request_id|job ?id|pollurl|queued)\b/i.test(x));

function buildBackend(b) {
  const res = beByUrl[b.url];
  if (!res) { issues.push(`NO ACCEPTS for url ${b.url} (will record with empty accepts → needs-review)`); }
  const provider = b.provider || res?.provider || "";
  return {
    url: b.url, method: (b.method || res?.method || "POST").toUpperCase(),
    provider, providerId: b.providerId ? slug(b.providerId) : (res?.providerId || slug(provider)),
    amount: (b.price != null ? b.price : res?.price?.amount) ?? null,
    accepts: res?.payment?.accepts || [],
    ...(res?.hosting ? { } : {}),
    probe: { status: 402, method: (b.method || "POST").toUpperCase(), payable: true, checkedAt: "2026-06-10T00:00:00.000Z" },
    ...(res?.firstParty ? { firstParty: true } : {}),
  };
}

function entryFromSvc(sv, oldEntry) {
  // keep ALL non-broken backends (nothing lost); selectability is gated on having accepts.
  const backends = (sv.backends || []).filter((b) => !isBrokenBe(b)).map(buildBackend);
  backends.sort((a, b) => (b.firstParty ? 1 : 0) - (a.firstParty ? 1 : 0));
  const hasAccepts = backends.some((b) => b.accepts.length > 0);
  let st, reason;
  if (!hasAccepts) { st = "hidden"; reason = "needs-review"; } // accepts not captured → record, don't serve
  else { [st, reason] = STATUS_MAP[sv.status] || ["hidden", "needs-review"]; }
  const provider = backends[0]?.provider || sv.backends?.[0]?.provider || oldEntry.provider || "";
  return {
    name: sv.name, kind: "api", provider, providerId: sv.providerId ? slug(sv.providerId) : slug(provider),
    aka: [...new Set([slug(sv.name), sv.op].filter(Boolean))],
    description: sv.description || "", tags: sv.tags || oldEntry.tags || [],
    modality: oldEntry.modality || { input: ["text"], output: ["json"] },
    backends,
    usage: {
      status: sv.status === "verified" ? "verified" : (sv.status === "broken" ? "broken" : "untested"),
      verifiedAt: "2026-06-10", resultPull: pollish(sv.quirks) ? "poll" : "sync", auth: "none",
      callShape: sv.callShape || "", inputExample: sv.inputExample || {}, outputShape: sv.outputShape || "",
      quirks: sv.quirks || [], needs: [], needsApproval: !!sv.outward,
      guide: (sv.description ? sv.description + " " : "") + (sv.callShape || "") + (sv.outputShape ? " Output: " + sv.outputShape : ""),
      costObservedUsd: sv.costObservedUsd || 0,
    },
    status: st, ...(reason ? { hiddenReason: reason } : {}),
  };
}

const perFile = {};
let replaced = 0, newEntries = 0, skipped = 0;
for (const r of results) {
  if (!r.services || !r.services.length || r.classification === "skip") { skipped++; continue; }
  const file = fileById[r.id];
  if (!file) { issues.push(`NO FILE mapping for result id ${r.id}`); skipped++; continue; }
  const built = r.services.map((sv) => entryFromSvc(sv, {})).filter((e) => e.backends.length > 0);
  if (!built.length) { issues.push(`${r.id}: all built entries had 0 backends (accepts lookup failed) — left original untouched`); skipped++; continue; }
  (perFile[file] ||= []).push({ oldId: r.id, built });
}

for (const [file, jobs] of Object.entries(perFile)) {
  const p = join(__dir, "curation", file);
  if (!existsSync(p)) { issues.push(`curation file missing: ${file}`); continue; }
  const j = JSON.parse(readFileSync(p, "utf8"));
  for (const job of jobs) {
    const i = j.entries.findIndex((e) => slug(e.name) === job.oldId || e.providerId === job.oldId || e.id === job.oldId);
    if (i < 0) { issues.push(`${file}: old entry '${job.oldId}' not found (slug match) — skipped`); continue; }
    const old = j.entries[i];
    const built = job.built.map((e) => ({ ...e, modality: old.modality || e.modality, tags: e.tags.length ? e.tags : (old.tags || []) }));
    j.entries.splice(i, 1, ...built);
    replaced++; newEntries += built.length;
  }
  if (APPLY) writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}

console.log(`${APPLY ? "APPLIED" : "DRY-RUN"}: replaced ${replaced} bundled entries → ${newEntries} op-services across ${Object.keys(perFile).length} files. skipped ${skipped}.`);
console.log(`issues (${issues.length}):`);
issues.slice(0, 60).forEach((x) => console.log("  - " + x));
if (issues.length > 60) console.log(`  … +${issues.length - 60} more`);
if (!APPLY) console.log("\n(dry-run — no files written. Re-run with --apply to write.)");
