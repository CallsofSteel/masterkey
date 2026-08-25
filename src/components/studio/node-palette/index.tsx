"use client";

// Masterkey — Bundle Studio node palette (spec §7.3). Replaces Flow's AgentCash/legacy-subtype palette.
// Cmd/Ctrl+K opens a command palette offering the §1.1 node KINDS plus a registry SERVICE search
// (/api/studio/services — same source as the service node, §3). Selecting a kind adds a blank node;
// selecting a service adds a service node with its serviceId preset (the config panel fills the rest).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Target,
  Zap,
  MessageSquare,
  GitBranch,
  TextCursorInput,
  FileOutput,
  Repeat,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type { NodeKind } from "@/lib/studio/types";

export type PaletteAdd = { kind: NodeKind; label: string; serviceId?: string };

const NODE_KINDS: { kind: NodeKind; label: string; description: string; icon: typeof Zap }[] = [
  { kind: "purpose", label: "Purpose", description: "Bundle name, description, when to use", icon: Target },
  { kind: "service", label: "Service", description: "Call a Masterkey registry service", icon: Zap },
  { kind: "instruction", label: "Instruction", description: "A plain-English reasoning step", icon: MessageSquare },
  { kind: "decision", label: "Decision", description: "Branch on a question / options", icon: GitBranch },
  { kind: "input", label: "Input", description: "Collect a value at run time", icon: TextCursorInput },
  { kind: "output", label: "Output", description: "Shape the final result", icon: FileOutput },
  { kind: "loop", label: "Loop", description: "Repeat steps over a collection", icon: Repeat },
];

type ServiceResult = { id: string; name: string; provider: string; category: string; price?: { display?: string } | null };

export function NodePalette({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (a: PaletteAdd) => void;
}) {
  const [query, setQuery] = useState("");
  const [services, setServices] = useState<ServiceResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      } else if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setServices([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced registry search for service nodes.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setServices([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/studio/services?q=${encodeURIComponent(q)}&limit=6`);
        const data = await res.json();
        if (alive) setServices(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (alive) setServices([]);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const add = useCallback(
    (a: PaletteAdd) => {
      onAdd(a);
      onOpenChange(false);
    },
    [onAdd, onOpenChange],
  );

  if (!open) return null;
  const q = query.trim().toLowerCase();
  const kinds = q ? NODE_KINDS.filter((k) => `${k.label} ${k.description}`.toLowerCase().includes(q)) : NODE_KINDS;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a node — type a kind or search services…"
            className="h-7 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {kinds.length > 0 && (
            <>
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Node types</p>
              {kinds.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => add({ kind: k.kind, label: k.label })}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <k.icon className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{k.label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{k.description}</span>
                  </span>
                </button>
              ))}
            </>
          )}
          {services.length > 0 && (
            <>
              <p className="mt-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Services</p>
              {services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => add({ kind: "service", label: s.name, serviceId: s.id })}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <Zap className="size-4 shrink-0 text-green-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{s.provider} · {s.category}</span>
                  </span>
                  {s.price?.display && <span className="shrink-0 text-[10px] text-muted-foreground">{s.price.display}</span>}
                </button>
              ))}
            </>
          )}
          {kinds.length === 0 && services.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No matches</p>
          )}
        </div>
      </div>
    </div>
  );
}
