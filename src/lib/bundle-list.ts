"use client";

// Shared client loader of bundle summaries for the Composer's "/"-command menu. /api/bundles is now
// AUTH-AWARE (curated + the signed-in user's own, with favorite/owner flags — spec §6.1), so we fetch
// fresh per mount (no cross-auth caching). Favorites-first ordering is left to the consumer (BundleMention).

import { useEffect, useState } from "react";
import type { BundleSummary } from "@/lib/bundles";

export type { BundleSummary };

export function useBundles(): BundleSummary[] {
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/bundles", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bundles"))))
      .then((d: { bundles?: BundleSummary[] }) => {
        if (alive) setBundles(d.bundles ?? []);
      })
      .catch(() => {
        /* keep empty on failure */
      });
    return () => {
      alive = false;
    };
  }, []);
  return bundles;
}
