// Masterkey — bundle loader (server-only). Bundles are curated "/"-command recipes: an ordered chain of
// Masterkey service calls + reasoning steps (output of one feeds the next) that the brain runs end-to-end.
// Mirrors registry.ts: reads data/bundles/*.json (bundled into Trigger + Vercel via additionalFiles /
// outputFileTracingIncludes). Never import from client code.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BundleGraph } from "./studio/types";

export interface BundleStep {
  label: string;
  serviceId?: string; // a registry serviceId to run for this step (omitted for pure reasoning / get_email_inbox steps)
  instruction: string;
}
export interface Bundle {
  slug: string;
  name: string;
  description: string;
  trigger?: string;
  inputs?: { name: string; prompt: string }[];
  // A curated bundle carries EITHER a legacy linear recipe (steps[]) OR a node graph (branches/loops).
  // The compiler (compile.ts:compileRecipe) accepts either; getBundles keeps any file with one of them.
  steps?: BundleStep[];
  graph?: BundleGraph;
}
/** Summary shape for the "/" menu (safe to expose publicly — no extra detail beyond the registry).
 *  `favorite`/`owner` are populated by the auth-aware /api/bundles route (spec §6.1); absent/false for
 *  the public curated-only view. */
export interface BundleSummary {
  slug: string;
  name: string;
  description: string;
  trigger?: string;
  favorite?: boolean; // this slug is in the signed-in user's favorites
  owner?: boolean; // a user-authored bundle (vs curated/global)
}

const DIR = join(process.cwd(), "data", "bundles");
const CACHE = process.env.NODE_ENV === "production";
let _cache: Bundle[] | null = null;

export function getBundles(): Bundle[] {
  if (CACHE && _cache) return _cache;
  let out: Bundle[] = [];
  try {
    out = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Bundle)
      .filter((b) => b && b.slug && (Array.isArray(b.steps) || !!b.graph));
  } catch {
    out = [];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  if (CACHE) _cache = out;
  return out;
}

export function getBundle(slug: string): Bundle | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null; // guard
  return getBundles().find((b) => b.slug === slug) ?? null;
}

export function getBundleSummaries(): BundleSummary[] {
  return getBundles().map((b) => ({ slug: b.slug, name: b.name, description: b.description, trigger: b.trigger }));
}
