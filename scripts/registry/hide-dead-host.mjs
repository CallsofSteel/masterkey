/**
 * hide-dead-host.mjs — mark every endpoint on a DEAD PROVIDER HOST as hidden, in the SOURCE (curation).
 *
 * Why this exists: when a provider shuts down, every endpoint we indexed on its host stops working at
 * once. Per the registry's never-delete rule, those entries STAY in our data as the track record
 * ("we indexed and tested this; it's gone") so discover-new.mjs reports them as `known-hidden` instead
 * of re-discovering and re-pay-testing them forever. This writes that verdict durably to curation, the
 * only layer curate.mjs projects from — a by-subcat edit would be silently reverted on the next build.
 *
 * What it touches (nothing else — no prices, usage text or quirks):
 *   backend  (manual object)      → status:"hidden"
 *   backend  (candidate ref, int) → resolved[<candidateIndex>].status:"hidden"   (curate reads ov?.status)
 *   operation                     → status:"hidden" + hiddenReason
 *   service                       → status:"hidden" + hiddenReason  — ONLY if EVERY endpoint is on the
 *                                   dead host. A service that also has live endpoints elsewhere keeps
 *                                   serving those; only its dead-host endpoints are hidden.
 *
 * Backend has no `hiddenReason` in the type (src/data/types.ts) — service/operation carry the reason.
 *
 * Usage: node scripts/registry/hide-dead-host.mjs --host=<substr> [--reason=dead] [--write]
 *        (dry-run unless --write). Run curate.mjs for each touched subcat afterwards.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CUR = join(__dir, "curation");
const CAND = join(__dir, "candidates");

const args = process.argv.slice(2);
const get = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const HOST = get("host");
const REASON = get("reason", "dead");
const WRITE = args.includes("--write");
const VALID = ["dead", "broken", "mpp", "untested", "needs-input", "over-cap", "needs-review"];
if (!HOST) { console.error("required: --host=<substring, e.g. orbisapi.com>"); process.exit(2); }
if (!VALID.includes(REASON)) { console.error(`--reason must be one of: ${VALID.join(", ")}`); process.exit(2); }

const onHost = (u) => (u || "").toLowerCase().includes(HOST.toLowerCase());
const tally = { svcHidden: 0, svcMixed: 0, backends: 0, candRefs: 0, ops: 0, files: 0 };
const changes = [];

for (const f of readdirSync(CUR).filter((x) => x.endsWith(".json"))) {
  const sub = f.replace(/\.json$/, "");
  const curPath = join(CUR, f);
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  if (!Array.isArray(cur.entries)) continue;
  const candPath = join(CAND, f);
  const C = existsSync(candPath) ? JSON.parse(readFileSync(candPath, "utf8")).candidates || [] : [];
  let changed = false;

  for (const e of cur.entries) {
    // Resolve every endpoint to a URL, remembering how to write its status back.
    const eps = [];
    (e.backends || []).forEach((b) => {
      if (b && typeof b === "object") eps.push({ t: "backend", url: b.url, b });
      else if (typeof b === "number") eps.push({ t: "candRef", url: C[b]?.url || C[b]?.key, idx: b });
    });
    (e.operations || []).forEach((op) => { if (op && typeof op === "object") eps.push({ t: "op", url: op.url, op }); });

    const dead = eps.filter((x) => onHost(x.url));
    if (!dead.length) continue;

    for (const x of dead) {
      if (x.t === "backend") {
        if (x.b.status !== "hidden") { x.b.status = "hidden"; tally.backends++; changed = true; }
      } else if (x.t === "candRef") {
        // curate.mjs reads e.resolved?.[candidateIndex]?.status — key by the CANDIDATE INDEX, not position.
        e.resolved ||= {};
        const ov = e.resolved[x.idx] || {};
        if (ov.status !== "hidden") { e.resolved[x.idx] = { ...ov, status: "hidden" }; tally.candRefs++; changed = true; }
      } else {
        if (x.op.status !== "hidden" || x.op.hiddenReason !== REASON) { x.op.status = "hidden"; x.op.hiddenReason = REASON; tally.ops++; changed = true; }
      }
    }

    const live = eps.filter((x) => !onHost(x.url));
    if (live.length === 0) {
      if (e.status !== "hidden" || e.hiddenReason !== REASON) {
        changes.push(`  -hide  ${sub}/${e.name}  (was ${e.status || "?"}/${e.hiddenReason || "-"})`);
        e.status = "hidden"; e.hiddenReason = REASON; changed = true;
      }
      tally.svcHidden++;
    } else {
      changes.push(`  ~mixed ${sub}/${e.name}  — ${dead.length} dead-host ep hidden, ${live.length} kept live`);
      tally.svcMixed++;
    }
  }

  if (changed) { tally.files++; if (WRITE) writeFileSync(curPath, JSON.stringify(cur, null, 2) + "\n"); }
}

console.log(`hide-dead-host ${WRITE ? "" : "(DRY-RUN) "}— host="${HOST}" reason="${REASON}"`);
console.log(`services: ${tally.svcHidden} hidden (all endpoints dead) | ${tally.svcMixed} mixed (kept, dead ep hidden)`);
console.log(`endpoints newly hidden: ${tally.backends} manual backends, ${tally.candRefs} candidate-refs, ${tally.ops} operations`);
console.log(`curation files ${WRITE ? "written" : "that would change"}: ${tally.files}`);
if (changes.length) { console.log(`\nchanges (${changes.length}):`); changes.forEach((c) => console.log(c)); }
console.log(WRITE ? "\nwrote curation. Run curate.mjs --subcat=<each> then verify-drift.mjs." : "\n(dry-run — wrote nothing; pass --write)");
