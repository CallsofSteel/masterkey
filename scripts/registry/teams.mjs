// Operating-team tags for registry endpoints — WHO runs the host behind a backend/operation.
//
// A "team" is a third-party provider/gateway that OPERATES the endpoint. It may front many underlying
// models/services (e.g. BlockRun serves GPT-Image / Nano-Banana / Seedance; Orthogonal & Sponge proxy
// dozens of upstreams), so the team is the operator of the HOST, not the model. Tagged by host so a
// future trust-based ranking/filter can prefer endpoints from known teams. This mirrors the firstParty
// (1P) tag: derived in the build pipeline (curate.mjs) and backfilled across every by-subcat file by
// apply-teams.mjs. Host-based on purpose — operations carry only a `url`, no provider field.
//
// To add a team later: append a rule to TEAM_RULES (FIRST match wins; keep tests host-specific).

export const TEAM_RULES = [
  // BlockRun — every blockrun-operated host (blockrun.ai + their own infra subdomains, e.g. *.run.app).
  { team: "BlockRun", test: (h) => /(^|\.)blockrun/.test(h) },
  // Orthogonal — api.orthogonal.com + orth.sh (incl. x402.orth.sh).
  { team: "Orthogonal", test: (h) => /(^|\.)orthogonal\.com$/.test(h) || /(^|\.)orth\.sh$/.test(h) },
  // Sponge — paysponge.com and its x402 subdomains (e.g. 2captcha.x402.paysponge.com).
  { team: "Sponge", test: (h) => /(^|\.)paysponge\.com$/.test(h) },
  // Merit — the whole stable* family on .dev/.io (stableenrich.dev, stablestudio.dev, stablephone.dev, …)
  // plus the AgentCash gateway family (agentcash.*, e.g. agentcash.honcho.dev fronting the Honcho service).
  { team: "Merit", test: (h) => /(^|\.)stable[a-z0-9]+\.(dev|io)$/.test(h) || /(^|\.)agentcash\./.test(h) },
  // Heurist — the Heurist Mesh agent gateway (mesh.heurist.xyz / heurist.ai) fronting ~24 agents.
  { team: "Heurist", test: (h) => /(^|\.)heurist\.(xyz|ai)$/.test(h) },
  // Apify — the Apify actor platform (api.apify.com) running ~18k x402 scrapers via 3 run endpoints.
  { team: "Apify", test: (h) => /(^|\.)apify\.com$/.test(h) },
  // --- Tier-3 recurring providers: lower-trust but on their OWN registered domain (see TEAM_TIER) ---
  { team: "Orbis", test: (h) => /(^|\.)orbisapi\.com$/.test(h) },
  { team: "Xona", test: (h) => /(^|\.)xona-agent\.com$/.test(h) },
  { team: "Strale", test: (h) => /(^|\.)strale\.io$/.test(h) },
  { team: "x402node", test: (h) => /(^|\.)x402node\.dev$/.test(h) },
  { team: "CrushRewards", test: (h) => /(^|\.)crushrewards\.dev$/.test(h) },
  { team: "2s", test: (h) => /(^|\.)2s\.io$/.test(h) },
  // Purch — agent-commerce gateway (purch.xyz) wrapping Amazon/Shopify checkout via Crossmint over x402.
  { team: "Purch", test: (h) => /(^|\.)purch\.xyz$/.test(h) },
  // --- Tier-4 recurring proxies WITHOUT their own domain (shared platform hosts) ---
  { team: "x402 Gateway", test: (h) => h === "x402-gateway-production.up.railway.app" },
  { team: "gg402", test: (h) => h === "gg402.vercel.app" },
  { team: "x402 Deployer", test: (h) => /(^|\.)x402-deployer\..*workers\.dev$/.test(h) },
  { team: "NetIntel", test: (h) => /^netintel-.*\.up\.railway\.app$/.test(h) },
];

// Markdown grading ONLY (the team TAG is identical in the registry regardless of tier). See
// TEAMS_AND_FIRST_PARTY.md. Tier 1 = first-party providers (not a team). Tier 2 = teams with a direct
// relationship. Tier 3 = recurring lower-trust providers that have their OWN registered domain.
// Tier 4 = recurring proxies on a shared platform host (vercel.app/workers.dev/railway.app) — no own domain.
export const TEAM_TIER = {
  BlockRun: 2, Merit: 2, Sponge: 2, Orthogonal: 2, Apify: 2,
  Heurist: 3, Orbis: 3, Xona: 3, Strale: 3, x402node: 3, CrushRewards: 3, "2s": 3, Purch: 3,
  "x402 Gateway": 4, gg402: 4, "x402 Deployer": 4, NetIntel: 4,
};

/** The operating team for a host, or null if none of the known teams runs it. */
export function teamForHost(host) {
  const h = (host || "").toLowerCase();
  for (const r of TEAM_RULES) if (r.test(h)) return r.team;
  return null;
}

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

/** Distinct, sorted operating teams across a service's backends + operations (no mutation). */
export function teamsForService(svc) {
  const set = new Set();
  for (const b of svc.backends || []) { const t = teamForHost(hostOf(b.url)); if (t) set.add(t); }
  for (const o of svc.operations || []) { const t = teamForHost(hostOf(o.url)); if (t) set.add(t); }
  return [...set].sort();
}

/** Stamp `team` on each backend + operation by host (deletes stale tags); returns the distinct teams. */
export function stampTeams(svc) {
  for (const b of svc.backends || []) { const t = teamForHost(hostOf(b.url)); if (t) b.team = t; else delete b.team; }
  for (const o of svc.operations || []) { const t = teamForHost(hostOf(o.url)); if (t) o.team = t; else delete o.team; }
  return teamsForService(svc);
}
