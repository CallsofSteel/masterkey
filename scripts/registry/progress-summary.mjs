#!/usr/bin/env node
// progress-summary.mjs — render the durable indexing ledger into a human-readable INDEXING_PROGRESS.md.
//
// Source of truth: data/registry/indexing-progress.jsonl (append-only; index-endpoints.mjs --probe-only and
// apply-proposals.mjs --apply append to it, so nothing processed is ever lost). Latest row per URL wins.
// Run after any batch:  node scripts/registry/progress-summary.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LEDGER = join(ROOT, "data/registry/indexing-progress.jsonl");
const OUT = join(ROOT, "INDEXING_PROGRESS.md");

const rows = existsSync(LEDGER)
  ? readFileSync(LEDGER, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// latest row per URL wins (append-only state transitions)
const latest = new Map();
for (const r of rows) if (r.url) latest.set(r.url, r);
const all = [...latest.values()];
const by = (s) => all.filter((r) => r.status === s);
const count = (s) => by(s).length;

const spent = all.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
const STATES = ["indexed", "folded", "deferred-prepaid", "deferred-over-cap", "deferred-needs-input", "deferred-needs-subcat", "deferred-charge-then-error", "deferred-free-convention", "held-unresolved-merge", "unreachable", "needs-accepts", "rejected", "pay-failed", "unsure", "duplicate", "probed"];
const mix = STATES.filter((s) => count(s)).map((s) => `${s} ${count(s)}`).join(" · ");

const line = (r) => `- \`${r.url}\`${r.service ? ` → **${r.service}**` : ""}${r.subcat ? ` (${r.subcat})` : ""}${r.priceUsd != null ? ` — $${r.priceUsd}` : ""}${r.note ? ` — ${r.note}` : ""}`;

let md = `# Registry Indexing — Progress Ledger\n\n`;
md += `_Auto-generated from \`data/registry/indexing-progress.jsonl\` by \`scripts/registry/progress-summary.mjs\`. Do not hand-edit; append to the JSONL (the tools do this automatically) and re-run._\n\n`;
md += `**Processed: ${all.length} endpoints · ${mix} · spend logged $${spent.toFixed(4)}**\n\n`;

md += `## ✅ Indexed as new services (${count("indexed")})\n\n` + (by("indexed").map(line).join("\n") || "_none_") + "\n\n";
md += `## 🔗 Folded as backends onto existing services (${count("folded")})\n\n` + (by("folded").map(line).join("\n") || "_none_") + "\n\n";

md += `## ⏳ Revisit backlog (parked, not lost)\n\n`;
const backlog = [
  ["deferred-prepaid", "Prepaid-balance/SIWX provider — does NOT fit the per-call model; don't revisit for cap"],
  ["deferred-over-cap", "Over the per-call cap — raise the cap to collect"],
  ["deferred-needs-input", "Needs an input we can't synthesise (id/file/companion-chain)"],
  ["deferred-needs-subcat", "Classified into a subcat with no curation file yet — create it to index"],
  ["deferred-charge-then-error", "Paid but the provider errored — re-verify with a corrected call"],
  ["deferred-free-convention", "Free endpoint — index with protocols:[\"free\"] when wanted"],
  ["held-unresolved-merge", "Looks like a merge but the target service name didn't resolve"],
  ["unreachable", "Network/DNS unreachable — retry serially before hiding"],
  ["needs-accepts", "Returned 402 but no decodable accepts — investigate"],
  ["unsure", "Flagged for human review"],
];
for (const [s, desc] of backlog) if (count(s)) md += `### ${s} (${count(s)}) — ${desc}\n\n${by(s).map(line).join("\n")}\n\n`;

md += `## 🚫 Rejected (not payment-or-nothing) (${count("rejected")})\n\n` + (by("rejected").map(line).join("\n") || "_none_") + "\n\n";
md += `## ⚠️ Pay-failed (${count("pay-failed")})\n\n` + (by("pay-failed").map(line).join("\n") || "_none_") + "\n\n";
md += `## ℹ️ Other\n\n`;
if (count("duplicate")) md += `### duplicate (${count("duplicate")}) — alias of another indexed endpoint; not a redundant entry\n\n${by("duplicate").map(line).join("\n")}\n\n`;
if (count("probed")) md += `### probed / in-progress (${count("probed")}) — pre-filtered payable, not yet run through an agent\n\n${by("probed").map(line).join("\n")}\n`;

writeFileSync(OUT, md);
console.log(`wrote ${OUT.replace(ROOT + "/", "")} — ${all.length} endpoints (${mix})`);
