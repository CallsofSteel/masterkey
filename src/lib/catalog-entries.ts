"use client";

// Shared client cache of the catalog's summary entries (EntrySummary[]) for the Composer's @-mention
// menu. /api/catalog is summary-only + public + already excludes hidden services, so it's safe to fetch
// from the client and reuse across every Composer instance (one fetch, module-cached).

import { useEffect, useState } from "react";
import type { EntrySummary } from "@/data/types";

let _cache: EntrySummary[] | null = null;
let _promise: Promise<EntrySummary[]> | null = null;

function load(): Promise<EntrySummary[]> {
  if (_cache) return Promise.resolve(_cache);
  if (!_promise) {
    _promise = fetch("/api/catalog", { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("catalog"))))
      .then((d: { entries?: EntrySummary[] }) => {
        _cache = d.entries ?? [];
        return _cache;
      })
      .catch(() => {
        _promise = null; // allow a later retry
        return [];
      });
  }
  return _promise;
}

export function useCatalogEntries(): EntrySummary[] {
  const [entries, setEntries] = useState<EntrySummary[]>(_cache ?? []);
  useEffect(() => {
    if (_cache) return;
    let alive = true;
    void load().then((e) => {
      if (alive) setEntries(e);
    });
    return () => {
      alive = false;
    };
  }, []);
  return entries;
}
