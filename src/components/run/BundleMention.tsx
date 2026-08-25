"use client";

// Masterkey — the "/"-command dropdown for the Composer. Renders matching bundles (curated multi-step
// service chains) above the input; selecting one inserts /slug so the agent runs the whole recipe.
// Keyboard nav is handled by the Composer; this is presentational + mouse-select.

import { Workflow, Star } from "lucide-react";
import type { BundleSummary } from "@/lib/bundle-list";
import { cn } from "@/lib/utils";

export function BundleMention({
  results,
  selectedIndex,
  onSelect,
  onHover,
  placement = "up",
}: {
  results: BundleSummary[];
  selectedIndex: number;
  onSelect: (b: BundleSummary) => void;
  onHover: (i: number) => void;
  /** "up" = open above the input (default; chat session); "down" = below (home page, avoids clipping). */
  placement?: "up" | "down";
}) {
  if (!results.length) return null;
  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-50 overflow-hidden rounded-xl border border-border bg-card shadow-lg",
        placement === "down" ? "top-full mt-2" : "bottom-full mb-2",
      )}
    >
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Bundles · multi-step recipes
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {results.map((b, i) => (
          <button
            key={b.slug}
            type="button"
            onMouseEnter={() => onHover(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onSelect(b);
            }}
            className={cn(
              "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
              i === selectedIndex ? "bg-accent" : "bg-transparent hover:bg-accent/50",
            )}
          >
            <Workflow className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{b.name}</span>
                {b.favorite && <Star className="size-3 shrink-0 fill-amber-400 text-amber-500" />}
                {b.owner && <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground">yours</span>}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">{b.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
