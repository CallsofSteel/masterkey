"use client";

// Masterkey — Bundle Studio service node (canvas renderer + add-search). Spec §3.4: the inline endpoint
// search is OUR registry (search-as-you-type over /api/studio/services), not AgentCash. On pick we set the
// node's `serviceId`, then fetch /api/studio/service/[id] to embed the BundleService snapshot + pre-select
// the recommended/first-party backend — so a node added here is immediately runnable (no live probe, D6).

import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { LayoutGrid, Loader2, Search, Zap } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { serviceBrowserAtom, updateNodeDataAtom, type WorkflowNodeData } from "@/lib/studio/workflow-store";

type SearchResult = {
  id: string;
  name: string;
  provider: string;
  category: string;
  description: string;
  price?: { display?: string; amount?: number | null } | null;
};

type ServiceNodeProps = NodeProps & { data: WorkflowNodeData; id: string };

function ServiceSearch({ nodeId }: { nodeId: string }) {
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const setServiceBrowser = useSetAtom(serviceBrowserAtom);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Search-as-you-type over our registry (debounced). Replaces Flow's AgentCash /api/discover/search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/studio/services?q=${encodeURIComponent(q)}&limit=8`);
        const data = await res.json();
        if (!cancelled) {
          setResults(Array.isArray(data.results) ? data.results : []);
          setSearched(true);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const handlePick = useCallback(
    async (r: SearchResult) => {
      // Set the registry id immediately; the config panel (§3.3) reads it and refines on selection.
      updateNodeData({ id: nodeId, data: { serviceId: r.id, label: r.name, description: r.description || r.name } });
      // Fetch the embedded detail so the node is fully configured (snapshot + recommended backend) right away.
      try {
        const res = await fetch(`/api/studio/service/${encodeURIComponent(r.id)}`);
        if (!res.ok) return;
        const { detail, bundle } = await res.json();
        const rec =
          detail.backends?.find((b: { providerId: string }) => b.providerId === detail.recommendedBackendProviderId) ??
          detail.backends?.[0];
        updateNodeData({
          id: nodeId,
          data: {
            service: bundle,
            ...(detail.recommendedBackendProviderId ? { backendProviderId: detail.recommendedBackendProviderId } : {}),
            endpoint: rec
              ? {
                  origin: String(rec.url).replace(/^(https?:\/\/[^/]+).*$/, "$1"),
                  path: "",
                  method: rec.method,
                  price: rec.price?.amount != null ? String(rec.price.amount) : "0",
                  summary: detail.name,
                }
              : undefined,
          },
        });
      } catch {
        // Non-fatal — serviceId is set; the config panel fetches detail when the node is opened.
      }
    },
    [nodeId, updateNodeData],
  );

  return (
    <div className="flex w-full flex-col" onClick={(e) => e.stopPropagation()}>
      {/* Draggable header (NOT nodrag) so the blank node can be moved before a service is picked. */}
      <div className="flex cursor-grab items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-green-500 active:cursor-grabbing">
        <Zap className="size-3" /> Service
      </div>
      {/* Search body — nodrag/nowheel so typing + scrolling don't pan the canvas. */}
      <div className="flex flex-col gap-2 px-3 pb-3 nodrag nowheel">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-2 size-3 text-muted-foreground" />
        <input
          autoFocus
          className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
          autoComplete="one-time-code"
          data-1p-ignore
          data-lpignore="true"
          name="srch-mk-svc"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Masterkey services…"
          value={query}
        />
      </div>

      <button
        type="button"
        onClick={() => setServiceBrowser({ mode: "set", nodeId })}
        className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1.5 text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      >
        <LayoutGrid className="size-3" /> Browse all services
      </button>

      <div className="max-h-40 space-y-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          </div>
        ) : results.length > 0 ? (
          results.map((r) => (
            <button
              key={r.id}
              className="w-full rounded border border-border/50 px-2 py-1.5 text-left hover:bg-muted/50"
              onClick={() => handlePick(r)}
              type="button"
            >
              <p className="line-clamp-1 text-[10px] font-medium leading-snug">{r.name}</p>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="text-[8px] text-muted-foreground">{r.provider} · {r.category}</span>
                {r.price?.display && (
                  <span className="rounded-full bg-green-500/10 px-1 py-0.5 text-[7px] font-medium text-green-600 dark:text-green-400">
                    {r.price.display}
                  </span>
                )}
              </div>
            </button>
          ))
        ) : searched ? (
          <p className="py-3 text-center text-[10px] text-muted-foreground">No services found</p>
        ) : null}
      </div>
      </div>
    </div>
  );
}

export const ServiceNode = memo(({ data, selected, id }: ServiceNodeProps) => {
  const hasEndpoint = !!data.serviceId || !!data.endpoint;

  return (
    <div
      className={cn(
        "relative rounded-xl border-2 bg-card shadow-sm transition-all",
        hasEndpoint ? "w-56 px-4 py-3" : "w-64",
        selected ? "border-green-500 shadow-md shadow-green-500/20" : "border-green-500/30",
      )}
    >
      <Handle type="target" position={Position.Left} id="left" className="!size-3 !border-2 !border-background !bg-green-500" />

      {hasEndpoint ? (
        <>
          <div className="mb-1.5 flex items-center gap-2">
            <div className="rounded-lg bg-green-500/10 p-1">
              <Zap className="size-3.5 text-green-500" />
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wider text-green-500">Service</span>
            {data.endpoint?.price && (
              <span className="ml-auto rounded-full bg-green-500/10 px-1.5 py-0.5 text-[9px] font-medium text-green-600 dark:text-green-400">
                ${data.endpoint.price}
              </span>
            )}
          </div>

          <p className="line-clamp-2 text-xs font-medium leading-snug">
            {data.label || data.endpoint?.summary || "Untitled service"}
          </p>

          {data.description && data.description !== data.label && (
            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{data.description}</p>
          )}
        </>
      ) : (
        <ServiceSearch nodeId={id} />
      )}

      <Handle type="source" position={Position.Right} id="right" className="!size-3 !border-2 !border-background !bg-green-500" />
    </div>
  );
});

ServiceNode.displayName = "ServiceNode";
