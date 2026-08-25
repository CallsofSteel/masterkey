/**
 * gen-teams-doc.mjs — regenerate TEAMS_AND_FIRST_PARTY.md from the live registry + teams.mjs.
 * Three tiers: (1) First-party providers, (2) trusted teams (direct contact), (3) recurring providers
 * we don't have a close relationship with. The team TAG is identical in the registry across tiers;
 * the tier is markdown-only grading (see TEAM_TIER in teams.mjs).
 * Usage: node scripts/registry/gen-teams-doc.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEAM_TIER } from "./teams.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const BY = join(ROOT, "data/registry/by-subcat");
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };

const teamBrands = {}, teamHosts = {}, fpRaw = {};
for (const f of readdirSync(BY)) {
  for (const s of JSON.parse(readFileSync(join(BY, f), "utf8"))) {
    if (s.status === "hidden") continue;
    for (const b of s.backends || []) {
      if (b.status === "hidden") continue;
      if (b.team) { (teamBrands[b.team] ??= new Set()).add((s.provider || b.provider || "").trim()); (teamHosts[b.team] ??= new Set()).add(hostOf(b.url)); }
      if (b.firstParty) (fpRaw[(s.provider || b.provider || "").trim()] ??= new Set()).add(hostOf(b.url));
    }
    for (const o of s.operations || []) if (o.team) { (teamBrands[o.team] ??= new Set()).add((s.provider || "").trim()); (teamHosts[o.team] ??= new Set()).add(hostOf(o.url)); }
  }
}
// Apify is dynamic (not in by-subcat)
teamBrands.Apify = new Set(["~16,000 Apify Store actors (dynamic) — scrapers/automation for Instagram, Google Maps, LinkedIn, Amazon, Zillow, YouTube, lead-gen, e-commerce, real-estate, etc."]);
teamHosts.Apify = new Set(["api.apify.com"]);

// dedupe 1P providers case-insensitively
const fp = {};
for (const [name, hosts] of Object.entries(fpRaw)) { const k = name.toLowerCase().replace(/^sol\./, ""); if (!fp[k]) fp[k] = { name, hosts: new Set() }; if (/[A-Z]/.test(name) && !/[A-Z]/.test(fp[k].name)) fp[k].name = name; for (const h of hosts) fp[k].hosts.add(h); }

const tierTeams = (t) => Object.keys(TEAM_TIER).filter((x) => TEAM_TIER[x] === t).filter((x) => teamBrands[x]);
const NOTE = { Orbis: " ⚠️ mostly charge-then-404 (most endpoints failed testing — to revisit; 6 active / 30 hidden)" };

let md = "# MasterKey — Provider Trust Tiers\n\n";
md += "_Auto-generated from the live registry + `scripts/registry/teams.mjs` (" + new Date().toISOString().slice(0, 10) + "). Three tiers by relationship/trust. The **team tag is identical in the registry across tiers** — the tier is grading shown here only. Run `node scripts/registry/gen-teams-doc.mjs` to refresh._\n\n";

const fpKeys = Object.keys(fp).sort((a, b) => fp[a].name.toLowerCase().localeCompare(fp[b].name.toLowerCase()));
md += "## Tier 1 — First-party providers (" + fpKeys.length + ")\n\n_The service owner’s OWN host (`firstParty:true`). Highest trust; the run engine prefers these by default. (Prepaid-only providers are intentionally excluded.)_\n\n| Provider | Own host(s) |\n|---|---|\n";
for (const k of fpKeys) md += "| " + fp[k].name + " | " + [...fp[k].hosts].filter(Boolean).map((h) => "`" + h + "`").join(", ") + " |\n";

md += "\n## Tier 2 — Trusted teams (direct contact) (" + tierTeams(2).length + ")\n\n_Third-party operators/gateways we have a direct relationship with._\n\n| Team | Host(s) | Brands / services served |\n|---|---|---|\n";
for (const t of tierTeams(2)) md += "| **" + t + "** | " + [...(teamHosts[t] || [])].filter(Boolean).map((h) => "`" + h + "`").join(", ") + " | " + [...teamBrands[t]].filter(Boolean).sort().join(", ") + " |\n";

md += "\n## Tier 3 — Recurring providers, own domain (lower trust) (" + tierTeams(3).length + ")\n\n_Operators that recur in the registry but which we don’t have a close relationship with — they do run on their own registered domain. Team-tagged in the registry, graded here._\n\n| Team | Host(s) | Brands / services served |\n|---|---|---|\n";
for (const t of tierTeams(3)) md += "| **" + t + "** | " + [...(teamHosts[t] || [])].filter(Boolean).map((h) => "`" + h + "`").join(", ") + " | " + [...teamBrands[t]].filter(Boolean).sort().join(", ") + (NOTE[t] || "") + " |\n";

md += "\n## Tier 4 — Recurring proxies, no own domain (lowest trust) (" + tierTeams(4).length + ")\n\n_Recurring proxy/gateway endpoints on shared platform hosts (vercel.app / workers.dev / railway.app …) — no registered domain of their own. Functional + indexed, but lowest trust._\n\n| Team | Host(s) | Brands / services served |\n|---|---|---|\n";
for (const t of tierTeams(4)) md += "| **" + t + "** | " + [...(teamHosts[t] || [])].filter(Boolean).map((h) => "`" + h + "`").join(", ") + " | " + [...teamBrands[t]].filter(Boolean).sort().join(", ") + (NOTE[t] || "") + " |\n";

writeFileSync(join(ROOT, "TEAMS_AND_FIRST_PARTY.md"), md);
console.log(`Tier1 1P: ${fpKeys.length} | Tier2: ${tierTeams(2).join(",")} | Tier3: ${tierTeams(3).join(",")} | Tier4: ${tierTeams(4).join(",")}`);
