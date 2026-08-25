/**
 * gen-first-party.mjs — derive the first-party (1P) provider map from the agentic-market service catalog.
 *
 * The MasterKey run engine should DEFAULT to a service's own first-party provider (e.g. api.exa.ai for
 * Exa) rather than the cheapest aggregator route (blockrun/stableenrich proxying Exa). The authoritative
 * source of truth for "who is first-party" is the agentic-market config: a service with
 * integration_type === "1P" is operated by the provider itself, and its endpoint URLs' hosts are that
 * provider's own hosts.
 *
 * This script reads that config and writes a SMALL, committed file (data/registry/first-party.json) that
 * curate.mjs consumes to stamp `firstParty: true` on matching backends. Nothing is guessed: a backend is
 * only 1P if (a) its registry service matches a 1P config service by id/name/provider, AND (b) the
 * backend's host is one of that config service's own endpoint hosts.
 *
 * Output shape:
 *   { generatedAt, source, entries: [ { id, aliases: [normalized...], hosts: [host...] } ] }
 *
 * Run: node scripts/registry/gen-first-party.mjs [--config=<path>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const CONFIG = arg("config", "./config/services.json");
const OUT = join(ROOT, "data/registry/first-party.json");

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const services = Array.isArray(cfg) ? cfg : cfg.services || [];

const entries = [];
for (const s of services) {
  if (s.integration_type !== "1P") continue;
  const hosts = new Set();
  for (const e of s.endpoints || []) {
    const h = hostOf(e.url);
    if (h) hosts.add(h);
  }
  if (!hosts.size) continue; // a 1P service with no endpoint hosts can't anchor a match
  const aliases = new Set();
  for (const a of [s.id, s.name, s.provider]) {
    const n = norm(a);
    if (n) aliases.add(n);
  }
  // Also add the second-level domain of each host (api.exa.ai -> "exa", blockrun.ai -> "blockrun",
  // pro-api.coingecko.com -> "coingecko") so registry providerIds like "blockrun"/"exa" match even when
  // the config's display name normalizes differently (e.g. "BlockRun.AI" -> "blockrun-ai").
  for (const h of hosts) {
    const labels = h.split(".");
    if (labels.length >= 2) {
      const sld = norm(labels[labels.length - 2]);
      if (sld && sld.length > 1) aliases.add(sld);
    }
  }
  entries.push({ id: s.id || norm(s.name), aliases: [...aliases], hosts: [...hosts] });
}

// Merge in manually-confirmed 1P providers not in the agentic-market config (first-party-extra.json).
let extraCount = 0;
try {
  const extra = JSON.parse(readFileSync(join(__dir, "first-party-extra.json"), "utf8"));
  for (const e of extra.entries || []) {
    if (!e.id || !Array.isArray(e.hosts) || !e.hosts.length) continue;
    const existing = entries.find((x) => x.id === e.id);
    if (existing) {
      for (const h of e.hosts) if (!existing.hosts.includes(h)) existing.hosts.push(h);
      for (const a of e.aliases || []) if (!existing.aliases.includes(norm(a))) existing.aliases.push(norm(a));
    } else {
      entries.push({ id: e.id, aliases: [...new Set([norm(e.id), ...(e.aliases || []).map(norm)])].filter(Boolean), hosts: e.hosts });
      extraCount++;
    }
  }
} catch { /* optional */ }

const out = {
  generatedAt: new Date().toISOString(),
  source: CONFIG,
  note: "1P provider map for curate.mjs (stamps backend.firstParty). A backend is 1P iff its service matches an entry by alias AND its host is in that entry's hosts. Generated from the agentic-market config + first-party-extra.json (manual additions). Regenerate with gen-first-party.mjs.",
  entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
};
if (extraCount) console.log(`  merged ${extraCount} manual 1P provider(s) from first-party-extra.json`);
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${OUT}`);
console.log(`  1P services: ${entries.length} | total hosts: ${entries.reduce((n, e) => n + e.hosts.length, 0)}`);
console.log("  sample:", entries.slice(0, 6).map((e) => `${e.id}[${e.hosts.join(",")}]`).join("  "));
