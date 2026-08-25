"use client";

// Masterkey — the "@"-mention dropdown for the Composer (W2 §3.2). Renders the filtered service
// matches above the input; selection inserts the serviceId inline so the agent prefers it. Keyboard
// nav (arrows/enter/escape) is handled by the Composer; this is presentational + mouse-select.

import type { EntrySummary } from "@/data/types";
import { cn } from "@/lib/utils";

export function ServiceMention({
  results,
  selectedIndex,
  onSelect,
  onHover,
  placement = "up",
}: {
  results: EntrySummary[];
  selectedIndex: number;
  onSelect: (e: EntrySummary) => void;
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
      <div className="max-h-64 overflow-y-auto py-1">
        {results.map((e, i) => (
          <button
            key={e.id}
            type="button"
            onMouseEnter={() => onHover(i)}
            // onMouseDown (not onClick) + preventDefault so selecting doesn't blur the textarea first.
            onMouseDown={(ev) => {
              ev.preventDefault();
              onSelect(e);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors",
              i === selectedIndex ? "bg-accent" : "bg-transparent hover:bg-accent/50",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">{e.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {e.provider && e.provider !== "Various" ? `${e.provider} · ` : ""}
                {e.category}
              </span>
            </span>
            {e.price?.display && <span className="shrink-0 text-[11px] text-muted-foreground">{e.price.display}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
