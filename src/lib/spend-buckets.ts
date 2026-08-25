// Curated umbrella "spend buckets" for spend limits/permissions. Each bucket maps to a set of
// real registry category slugs, so a future real metering layer can attribute a service's spend
// to the right bucket. Kept framework-agnostic (no "use client") so both the store and UI import it.

export type BucketKey =
  | "media"
  | "web-search"
  | "ai"
  | "data"
  | "comms"
  | "commerce"
  | "infra";

export interface SpendBucket {
  key: BucketKey;
  label: string;
  short: string; // compact label for chips/selects
  /** Registry category slugs that roll up into this bucket. */
  cats: string[];
}

// Order matters — this is the display order in selects and the advanced limits grid.
export const SPEND_BUCKETS: SpendBucket[] = [
  { key: "media", label: "Media — image, video, audio", short: "Media", cats: ["media", "image-video-processing"] },
  { key: "web-search", label: "Web search", short: "Web search", cats: ["search"] },
  { key: "ai", label: "AI & LLMs", short: "AI & LLMs", cats: ["ai-ml"] },
  { key: "data", label: "Data & enrichment", short: "Data", cats: ["data-intelligence", "web-automation", "maps-location"] },
  { key: "comms", label: "Communication — email, SMS, voice", short: "Comms", cats: ["communication"] },
  { key: "commerce", label: "Payments & commerce", short: "Commerce", cats: ["payments-billing", "ecommerce"] },
  {
    key: "infra",
    label: "Infrastructure & dev",
    short: "Infra & dev",
    cats: [
      "infrastructure",
      "devtools-observability",
      "database-storage",
      "document-content",
      "security",
      "auth-identity",
      "analytics-bi",
      "scheduling-calendars",
      "forms-surveys",
    ],
  },
];

export const BUCKET_BY_KEY: Record<BucketKey, SpendBucket> = Object.fromEntries(
  SPEND_BUCKETS.map((b) => [b.key, b]),
) as Record<BucketKey, SpendBucket>;

/** Fallback bucket for any registry category not explicitly mapped (Appendix R5). */
export const DEFAULT_BUCKET: BucketKey = "infra";

const CATEGORY_TO_BUCKET: Record<string, BucketKey> = (() => {
  const m: Record<string, BucketKey> = {};
  for (const b of SPEND_BUCKETS) for (const c of b.cats) m[c] = b.key;
  return m;
})();

/** Map a registry category slug → its spend bucket (defaults to `infra` if unmapped). */
export function bucketForCategory(category: string): BucketKey {
  return CATEGORY_TO_BUCKET[category] ?? DEFAULT_BUCKET;
}

/** "all" = everything, otherwise a bucket key. The scope of a spend rule. */
export type RuleScope = "all" | BucketKey;

export function scopeLabel(scope: RuleScope): string {
  return scope === "all" ? "Everything" : BUCKET_BY_KEY[scope]?.short ?? scope;
}

export type RulePeriod = "per-call" | "per-session" | "per-day" | "per-month";

export const RULE_PERIODS: { value: RulePeriod; label: string; noun: string }[] = [
  { value: "per-call", label: "Per call", noun: "call" },
  { value: "per-session", label: "Per session", noun: "session" },
  { value: "per-day", label: "Per day", noun: "day" },
  { value: "per-month", label: "Per month", noun: "month" },
];

export function periodLabel(period: RulePeriod): string {
  return RULE_PERIODS.find((p) => p.value === period)?.label ?? period;
}
