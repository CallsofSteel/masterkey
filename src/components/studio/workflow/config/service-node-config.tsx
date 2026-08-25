"use client";

// Masterkey — Bundle Studio: registry-backed service node config (spec §3.3). Replaces Flow's AgentCash
// live-probe/try panel. A service node carries a registry `serviceId`; this panel fetches the embedded
// detail from /api/studio/service/[id] (validated schema/payment/usage — NO live probe, NO payment, D6),
// lets the author pick a backend (first-party/recommended pre-selected), and drives an inputMap field
// editor from the selected backend's input schema. The "Test" affordance is whole-bundle E2E (§10), not
// per-node.

import { useSetAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { nodesAtom, updateNodeDataAtom, type WorkflowNode, type WorkflowNodeData } from "@/lib/studio/workflow-store";
import type { BundleService } from "@/lib/bundle/format";

// Shapes we consume from GET /api/studio/service/[id] (getServiceDetail + serviceToBundle).
interface BackendChoice {
  provider: string;
  providerId: string;
  firstParty: boolean;
  recommended: boolean;
  url: string;
  method: string;
  price?: { display?: string; amount?: number | null; unit?: string } | null;
  payment?: { protocols?: string[]; accepts?: { network: string }[] } | null;
  inputSchema?: Record<string, unknown> | null;
  async?: { isAsync?: boolean } | null;
}
interface ServiceDetail {
  id: string;
  name: string;
  provider: string;
  category: string;
  backends: BackendChoice[];
  recommendedBackendProviderId: string | null;
  usage?: { guide?: string; quirks?: string[] };
  operations?: { name: string; inputSchema?: Record<string, unknown> | null }[];
}
interface ServiceResult {
  detail: ServiceDetail;
  bundle: BundleService;
}

/** JSON-schema → ordered [key, prop, required] for the inputMap editor. */
function schemaFields(schema: Record<string, unknown> | null | undefined): { key: string; type: string; desc: string; required: boolean }[] {
  if (!schema) return [];
  const props = (schema.properties || schema) as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[] | undefined) ?? [];
  return Object.entries(props)
    .filter(([k]) => !["type", "required", "properties", "$schema"].includes(k))
    .map(([key, p]) => ({
      key,
      type: String(p?.type ?? ""),
      desc: String(p?.description ?? ""),
      required: required.includes(key),
    }));
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ServiceNodeConfig({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const allNodes = useAtomValue(nodesAtom);
  const d = node.data;
  const serviceId = d.serviceId;
  const [result, setResult] = useState<ServiceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which inputMap field is focused — so a reference chip inserts into the right field (§7.5).
  const [focusedField, setFocusedField] = useState<string | null>(null);

  // Upstream steps the author can reference. Refs are ID-BASED ({{nodeId.output}}) so they survive a
  // relabel (the node id never changes) — this is why no "auto-update on relabel" pass is needed (§7.5).
  const refNodes = allNodes
    .filter((n) => n.id !== node.id && n.data?.type !== "purpose")
    .map((n) => ({ id: n.id, label: n.data?.label || n.id }));

  const set = useCallback(
    (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields }),
    [update, node.id],
  );

  // Fetch the embedded registry detail whenever the node's serviceId changes.
  useEffect(() => {
    if (!serviceId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/studio/service/${encodeURIComponent(serviceId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Service not found in the registry." : "Failed to load service.");
        return (await res.json()) as ServiceResult;
      })
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        // Refresh the embedded snapshot + lightweight renderer fields so the node + export stay current.
        const rec =
          r.detail.backends.find((b) => b.providerId === (d.backendProviderId ?? r.detail.recommendedBackendProviderId)) ??
          r.detail.backends[0];
        set({
          service: r.bundle,
          ...(d.backendProviderId ? {} : r.detail.recommendedBackendProviderId ? { backendProviderId: r.detail.recommendedBackendProviderId } : {}),
          endpoint: rec
            ? {
                origin: rec.url.replace(/^(https?:\/\/[^/]+).*$/, "$1"),
                path: "",
                method: rec.method,
                price: rec.price?.amount != null ? String(rec.price.amount) : "0",
                summary: r.detail.name,
              }
            : d.endpoint,
        });
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // Re-run only on serviceId change (not on every node.data mutation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  if (!serviceId) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
        No service selected. Pick a Masterkey service from the node palette to embed its endpoint here.
      </div>
    );
  }
  if (loading && !result) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading service detail…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}</div>;
  }
  if (!result) return null;

  const { detail, bundle } = result;
  const selectedId = d.backendProviderId ?? detail.recommendedBackendProviderId ?? detail.backends[0]?.providerId;
  const selected = detail.backends.find((b) => b.providerId === selectedId) ?? detail.backends[0];
  const op = d.operation ? detail.operations?.find((o) => o.name === d.operation) : undefined;
  const inputSchema = op?.inputSchema ?? selected?.inputSchema ?? null;
  const fields = schemaFields(inputSchema);
  const needsApproval = bundle.endpoints.some((e) => e.needsApproval);
  const isAsync = !!selected?.async?.isAsync || bundle.endpoints.some((e) => e.async?.isAsync);

  return (
    <div className="space-y-4">
      {/* Service summary */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{detail.name}</p>
          <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{detail.id}</code>
        </div>
        <p className="text-[10px] text-muted-foreground">{detail.provider} · {detail.category}</p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {needsApproval && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-3" /> Approval-gated
            </span>
          )}
          {isAsync && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
              <Clock className="size-3" /> Async / polled
            </span>
          )}
        </div>
      </div>

      {/* Backend selector — first-party/recommended pre-selected */}
      {detail.backends.length > 0 && (
        <Field label="Provider" hint="Defaults to the official/first-party provider. Pin another only on purpose.">
          <div className="space-y-1.5">
            {detail.backends.map((b) => (
              <label
                key={b.providerId}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                  b.providerId === selectedId ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  className="accent-[var(--primary)]"
                  checked={b.providerId === selectedId}
                  onChange={() => set({ backendProviderId: b.providerId })}
                />
                <span className="min-w-0 flex-1 truncate">{b.provider}</span>
                {b.firstParty && <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-600 dark:text-emerald-400">first-party</span>}
                {b.recommended && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">recommended</span>}
                {b.price?.display && <span className="shrink-0 text-[10px] text-muted-foreground">{b.price.display}</span>}
              </label>
            ))}
          </div>
        </Field>
      )}

      {/* Selected backend detail (read-only) */}
      {selected && (
        <div className="rounded-lg border p-3 space-y-1 text-[10px] text-muted-foreground">
          <p><code className="font-mono text-foreground">{selected.method} {selected.url}</code></p>
          {selected.price?.display && <p>Price: {selected.price.display}{selected.price.unit ? ` (${selected.price.unit})` : ""}</p>}
          {selected.payment?.protocols?.length ? (
            <p>Pay via: {selected.payment.protocols.join(", ")}{selected.payment.accepts?.length ? ` · ${[...new Set(selected.payment.accepts.map((a) => a.network))].join(", ")}` : ""}</p>
          ) : null}
        </div>
      )}

      {/* api-kind operation selector */}
      {detail.operations && detail.operations.length > 0 && (
        <Field label="Operation">
          <select
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs"
            value={d.operation ?? ""}
            onChange={(e) => set({ operation: e.target.value || undefined })}
          >
            <option value="">(choose an operation)</option>
            {detail.operations.map((o) => (
              <option key={o.name} value={o.name}>{o.name}</option>
            ))}
          </select>
        </Field>
      )}

      {/* Input mapping — drive from the selected backend/operation schema */}
      {fields.length > 0 && (
        <Field label="Inputs" hint="Map each field to a value or a reference like {{nodeId.path}} from an earlier step.">
          <div className="space-y-2">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <code className="font-mono text-foreground">{f.key}</code>
                  {f.required && <span className="text-red-500">*</span>}
                  {f.type && <span className="text-muted-foreground">{f.type}</span>}
                </div>
                <Input
                  className="h-8 text-xs"
                  placeholder={f.desc || `value or {{ref}} for ${f.key}`}
                  value={d.inputMap?.[f.key] ?? ""}
                  onFocus={() => setFocusedField(f.key)}
                  onChange={(e) => set({ inputMap: { ...(d.inputMap ?? {}), [f.key]: e.target.value } })}
                />
              </div>
            ))}
            {refNodes.length > 0 && (
              <div className="rounded-md border border-dashed p-2">
                <p className="mb-1 text-[10px] text-muted-foreground">
                  Insert a reference{focusedField ? ` into "${focusedField}"` : " (focus a field first)"}:
                </p>
                <div className="flex flex-wrap gap-1">
                  {refNodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      disabled={!focusedField}
                      onClick={() =>
                        focusedField &&
                        set({ inputMap: { ...(d.inputMap ?? {}), [focusedField]: `${d.inputMap?.[focusedField] ?? ""}{{${n.id}.output}}` } })
                      }
                      className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent disabled:opacity-40"
                    >
                      {n.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Field>
      )}

      {/* Notes → folded into the recipe step instruction */}
      <Field label="Notes" hint="Guidance for this step — included in the bundle instructions.">
        <textarea
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          rows={2}
          value={d.notes ?? ""}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="e.g. Keep results to the last 7 days."
        />
      </Field>

      {/* Tested usage guidance from Registry QA */}
      {detail.usage?.guide && (
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">How to use</summary>
          <p className="mt-2 text-[11px] text-muted-foreground">{detail.usage.guide}</p>
          {detail.usage.quirks?.length ? (
            <ul className="mt-2 list-disc pl-4 text-[10px] text-muted-foreground">
              {detail.usage.quirks.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          ) : null}
        </details>
      )}
    </div>
  );
}
