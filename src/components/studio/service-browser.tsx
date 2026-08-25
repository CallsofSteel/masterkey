"use client";

// Masterkey — Bundle Studio service browser (spec §7.3). A modal "mini catalog": the same category-grouped
// directory as the home page, with a search bar on top, so authors can BROWSE and visually pick a service
// for a node (not just type-search). Reads the public registry index (/api/catalog). Presentational —
// WorkflowCanvas owns what happens on select (create a node, or set the service on an existing one).

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EntrySummary, RegistryIndex } from "@/data/types";

// Cache the index across opens (it's public + static-ish).
let _indexCache: RegistryIndex | null = null;

function ServiceIcon({ domain, name }: { domain?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (domain && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        className="size-4 shrink-0 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-sm bg-secondary text-[8px] font-medium text-muted-foreground">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function catLabel(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ServiceBrowserModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (serviceId: string, name: string) => void;
}) {
  const [index, setIndex] = useState<RegistryIndex | null>(_indexCache);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
    if (_indexCache) {
      setIndex(_indexCache);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch("/api/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("catalog"))))
      .then((data: RegistryIndex) => {
        _indexCache = data;
        if (alive) setIndex(data);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open]);

  // Filter + group by category. Entries that are payable/active only (the catalog already curates).
  const grouped = useMemo(() => {
    const entries = (index?.entries ?? []).filter((e) => e.status !== "hidden");
    const q = query.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) =>
          `${e.name} ${e.provider} ${e.category} ${e.subcategory} ${(e.tags ?? []).join(" ")} ${e.description ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : entries;
    const byCat = new Map<string, EntrySummary[]>();
    for (const e of filtered) {
      const list = byCat.get(e.category) ?? [];
      list.push(e);
      byCat.set(e.category, list);
    }
    return [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [index, query]);

  // Greedily distribute category blocks across 3 columns (each block stays whole), so all columns fill
  // roughly evenly — CSS multi-column + break-inside-avoid leaves tall blocks lopsided.
  const COLS = 3;
  const columns = useMemo(() => {
    const cols: [string, EntrySummary[]][][] = Array.from({ length: COLS }, () => []);
    const weights = new Array(COLS).fill(0);
    for (const block of grouped) {
      const target = weights.indexOf(Math.min(...weights));
      cols[target].push(block);
      weights[target] += block[1].length + 1.5; // +header weight
    }
    return cols;
  }, [grouped]);

  if (!open) return null;
  const total = grouped.reduce((n, [, es]) => n + es.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header + search */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services, or browse by category below…"
            className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] text-muted-foreground">{total} services</span>
          <button onClick={onClose} className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && !index ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
          ) : total === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No services match &ldquo;{query}&rdquo;.</p>
          ) : (
            <div className="flex items-start gap-6">
              {columns.map((col, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col gap-5">
                  {col.map(([cat, es]) => (
                    <div key={cat}>
                      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{catLabel(cat)}</h3>
                      <div className="flex flex-col">
                        {es.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => onSelect(e.id, e.name)}
                            className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                            title={e.description || e.name}
                          >
                            <ServiceIcon domain={e.domain} name={e.name} />
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground group-hover:text-primary">{e.name}</span>
                            {e.price?.display && (
                              <span className={cn("shrink-0 text-[10px] tabular-nums", /free/i.test(e.price.display) ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                                {e.price.display}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
