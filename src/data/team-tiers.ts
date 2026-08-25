// Masterkey — provider trust tiers, wired into ROUTING (not just documentation).
//
// Source of truth for the grading is `scripts/registry/teams.mjs` (`TEAM_TIER`), which also generates
// `service-docs/TEAMS_AND_FIRST_PARTY.md`. This module re-exports it rather than copying it, so the
// routing tiers and the published doc can never disagree.
//
//   T1  the service owner's OWN host (`firstParty:true`) — highest trust
//   T2  third-party operators/gateways we have a direct relationship with
//   T3  recurring providers on their own registered domain, no close relationship
//   T4  recurring proxies on a shared platform host (vercel.app / workers.dev / railway.app) — no own
//       domain, lowest trust. Kept and indexed, but only routed to as a fallback.
//
// IMPORTANT: the registry's `team` TAG is identical regardless of tier — tier is a grading applied on
// top, which is exactly why it has to live somewhere explicit like this.

export type ProviderTier = 1 | 2 | 3 | 4;

// Imported DIRECTLY from the registry pipeline — no mirror, so drift is impossible by construction.
// (An earlier version duplicated this map with a drift-guard test; the direct import is strictly better.)
export { TEAM_TIER } from "../../scripts/registry/teams.mjs";
import { TEAM_TIER as RAW_TIERS } from "../../scripts/registry/teams.mjs";
// The .mjs literal infers an exact-keys type; widen it so an arbitrary team name can index it.
const TIERS = RAW_TIERS as Record<string, ProviderTier>;

/**
 * Grade one endpoint. Resolution order matters:
 *
 *  1. `firstParty` wins outright. It is the owner's own endpoint, whatever infrastructure they deploy on.
 *  2. An explicitly graded TEAM beats the hosting heuristic. TEAMS_AND_FIRST_PARTY.md lists
 *     `blockrun-web-…-uc.a.run.app` under BlockRun (T2) even though it is a platform host — a known
 *     operator on shared infra is still that operator, so the human grading must override the guess.
 *  3. Otherwise, no own domain ⇒ T4. Catches the long tail of untagged `*.vercel.app` proxies that no
 *     TEAM_RULE matches (56 of 637 served backends are platform-hosted; only 4 teams are graded T4).
 *  4. Fall through to T3: an unknown provider on its own registered domain.
 */
export function tierOf(t: { firstParty?: boolean; team?: string; hosting?: "custom" | "platform" }): ProviderTier {
  if (t.firstParty) return 1;
  if (t.team && TIERS[t.team]) return TIERS[t.team];
  if (t.hosting === "platform") return 4;
  return 3;
}

/** `T1`…`T4`, for agent-facing output. */
export const tierLabel = (t: ProviderTier): `T${ProviderTier}` => `T${t}` as `T${ProviderTier}`;
