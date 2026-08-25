// Masterkey — Bundle Creator formatters (isomorphic, types-only; safe on server & client).
// Turns selected registry Service[] into (a) a structured JSON bundle and (b) a readable Markdown
// reference, both carrying the REAL info an external agent needs to call these x402 endpoints directly
// with its own wallet: endpoint URL/method, input/output schema, exact x402 payment requirements
// (protocol/network/asset/payTo/raw amount), model selectors, async-poll shape, and the QA `usage` guide.
// Single source of truth for the /api/bundle route, the brain context, and the copy/download payloads.

import type { Service, Backend, Operation, PaymentOption } from "@/data/types";

export interface BundleAccept {
  network: string;
  asset: string;
  payTo?: string;
  amount: string; // raw base units (as published by the x402 challenge)
  scheme: string;
}

export interface BundleEndpoint {
  provider: string;
  method: string;
  url: string;
  /** Selects a specific model on a shared multi-model gateway — must be sent with the call when present. */
  modelParam?: { name: string; value: string };
  /** Human price string, e.g. "$0.04 / call". */
  price: string;
  priceUsd: number | null;
  unit: string;
  protocols: string[];
  accepts: BundleAccept[];
  /** For api-kind services this is the operation name (e.g. "Send message"); model-kind backends omit it. */
  operation?: string;
  /** Outward/irreversible (send/mail/purchase/publish) — the recipient should gate on human approval. */
  needsApproval?: boolean;
  async?: {
    isAsync: boolean;
    pollUrlTemplate?: string;
    pollCost?: "free" | "siwx" | "per-poll";
    statusField?: string;
    completeValues?: string[];
    resultPath?: string;
  };
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

export interface BundleUsage {
  status: "verified" | "broken" | "untested";
  resultPull: "sync" | "poll" | "siwx" | "none";
  auth: "none" | "siwx";
  callShape: string;
  inputExample: Record<string, unknown>;
  outputShape: string;
  guide: string;
  quirks: string[];
}

export interface BundleService {
  id: string;
  name: string;
  kind: "model" | "api";
  provider: string;
  category: string;
  subcategory: string;
  description: string;
  pricing: string; // headline
  tags: string[];
  docs?: { llmTxt?: string; agentMd?: string; openapi?: string };
  endpoints: BundleEndpoint[];
  usage?: BundleUsage;
}

export interface ServiceBundle {
  schema: "masterkey.bundle/v1";
  source: string; // origin the bundle was exported from
  count: number;
  notes: string;
  services: BundleService[];
}

const ORIGIN = "https://masterkey.sh";

// A backend is callable-by-payment only if it's active x402 with at least one network in accepts —
// mirrors the MCP's isPayable + the catalog's isPayableBackend, so we never export a dead endpoint.
function isPayableBackend(b: Backend): boolean {
  return (
    b.status === "active" &&
    (b.payment?.protocols ?? []).includes("x402") &&
    (b.payment?.accepts ?? []).some((a) => !!a.network)
  );
}

function isPayableOperation(o: Operation): boolean {
  return (
    !o.trivial &&
    o.audience !== "internal" &&
    (o.payment?.protocols ?? []).includes("x402") &&
    (o.payment?.accepts ?? []).some((a) => !!a.network)
  );
}

function mapAccepts(accepts: PaymentOption[] | undefined): BundleAccept[] {
  return (accepts ?? [])
    .filter((a) => !!a.network)
    .map((a) => ({
      network: a.network,
      asset: a.asset,
      payTo: a.payTo,
      amount: a.amount,
      scheme: a.scheme || "exact",
    }));
}

function backendEndpoint(b: Backend): BundleEndpoint {
  return {
    provider: b.provider,
    method: b.method,
    url: b.url,
    ...(b.modelParam ? { modelParam: b.modelParam } : {}),
    price: b.price?.display ?? "Varies",
    priceUsd: b.price?.amount ?? null,
    unit: b.price?.unit ?? "per call",
    protocols: b.payment?.protocols ?? ["x402"],
    accepts: mapAccepts(b.payment?.accepts),
    ...(b.needsApproval ? { needsApproval: true } : {}),
    ...(b.async?.isAsync
      ? {
          async: {
            isAsync: true,
            pollUrlTemplate: b.async.pollUrlTemplate,
            pollCost: b.async.poll?.cost,
            statusField: b.async.poll?.statusField ?? b.async.submitStatusField,
            completeValues: b.async.poll?.completeValues,
            resultPath: b.async.poll?.resultPath,
          },
        }
      : {}),
    inputSchema: b.inputSchema ?? null,
    outputSchema: b.outputSchema ?? null,
  };
}

function operationEndpoint(o: Operation): BundleEndpoint {
  return {
    provider: o.name,
    method: o.method,
    url: o.url,
    ...(o.modelParam ? { modelParam: o.modelParam } : {}),
    price: o.price?.display ?? "Varies",
    priceUsd: o.price?.amount ?? null,
    unit: o.price?.unit ?? "per call",
    protocols: o.payment?.protocols ?? ["x402"],
    accepts: mapAccepts(o.payment?.accepts),
    operation: o.name,
    ...(o.needsApproval ? { needsApproval: true } : {}),
    ...(o.async?.isAsync
      ? {
          async: {
            isAsync: true,
            pollUrlTemplate: o.async.pollUrlTemplate,
            pollCost: o.async.poll?.cost,
            statusField: o.async.poll?.statusField ?? o.async.submitStatusField,
            completeValues: o.async.poll?.completeValues,
            resultPath: o.async.poll?.resultPath,
          },
        }
      : {}),
    inputSchema: o.inputSchema,
    outputSchema: o.outputSchema,
  };
}

/** Collect the callable, payable endpoints of a service: payable backends (model kind) + payable
 *  operations (api kind). Falls back to ALL backends only if none are flagged payable (so a service
 *  with stripped accepts still surfaces its endpoint shape, clearly without payment detail). */
export function endpointsForBundle(svc: Service): BundleEndpoint[] {
  const out: BundleEndpoint[] = [];
  const backends = svc.backends ?? [];
  const payableBackends = backends.filter(isPayableBackend);
  for (const b of (payableBackends.length ? payableBackends : backends)) out.push(backendEndpoint(b));
  for (const o of svc.operations ?? []) if (isPayableOperation(o)) out.push(operationEndpoint(o));
  return out;
}

export function serviceToBundle(svc: Service): BundleService {
  return {
    id: svc.id,
    name: svc.name,
    kind: svc.kind,
    provider: svc.provider,
    category: svc.category,
    subcategory: svc.subcategory,
    description: svc.description,
    pricing: `${svc.pricing.headline}${svc.pricing.unit ? ` ${svc.pricing.unit}` : ""}`.trim(),
    tags: svc.tags ?? [],
    ...(svc.docs && (svc.docs.llmTxt || svc.docs.agentMd || svc.docs.openapi)
      ? {
          docs: {
            ...(svc.docs.llmTxt ? { llmTxt: svc.docs.llmTxt } : {}),
            ...(svc.docs.agentMd ? { agentMd: svc.docs.agentMd } : {}),
            ...(svc.docs.openapi ? { openapi: svc.docs.openapi } : {}),
          },
        }
      : {}),
    endpoints: endpointsForBundle(svc),
    ...(svc.usage
      ? {
          usage: {
            status: svc.usage.status,
            resultPull: svc.usage.resultPull,
            auth: svc.usage.auth,
            callShape: svc.usage.callShape,
            inputExample: svc.usage.inputExample ?? {},
            outputShape: svc.usage.outputShape,
            guide: svc.usage.guide,
            quirks: svc.usage.quirks ?? [],
          },
        }
      : {}),
  };
}

export function buildBundle(services: Service[]): ServiceBundle {
  const mapped = services.map(serviceToBundle);
  return {
    schema: "masterkey.bundle/v1",
    source: ORIGIN,
    count: mapped.length,
    notes:
      "Real x402 pay-per-use endpoints from the Masterkey registry. An agent can call each one directly, " +
      "paying per request in USDC over the x402 protocol (no API key) — it needs its own funded wallet on " +
      "the listed network(s). `amount` is in raw base units from the live 402 challenge; `payTo` is the " +
      "recipient. Send `modelParam` when present. Honor `needsApproval` for outward/irreversible calls.",
    services: mapped,
  };
}

// ---- Markdown rendering -------------------------------------------------------------------------

function fence(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

function endpointMd(e: BundleEndpoint): string {
  const lines: string[] = [];
  const head = e.operation ? `**${e.operation}**` : `**${e.provider}**`;
  lines.push(`${head} — \`${e.method} ${e.url}\``);
  lines.push(`- Price: ${e.price}${e.unit ? ` (${e.unit})` : ""}`);
  if (e.protocols.length) lines.push(`- Pay via: ${e.protocols.join(", ")}`);
  for (const a of e.accepts) {
    lines.push(`  - ${a.network}: asset \`${a.asset}\`${a.payTo ? ` → payTo \`${a.payTo}\`` : ""} · amount \`${a.amount}\` (${a.scheme})`);
  }
  if (e.modelParam) lines.push(`- Model selector: \`${e.modelParam.name}=${e.modelParam.value}\` (send with the request)`);
  if (e.needsApproval) lines.push(`- ⚠️ Outward/irreversible — gate on human approval before calling.`);
  if (e.async?.isAsync) {
    const bits = [
      e.async.pollUrlTemplate ? `poll \`${e.async.pollUrlTemplate}\`` : "poll for completion",
      e.async.pollCost ? `poll cost: ${e.async.pollCost}` : "",
      e.async.statusField ? `status field: \`${e.async.statusField}\`` : "",
      e.async.resultPath ? `result at: \`${e.async.resultPath}\`` : "",
    ].filter(Boolean);
    lines.push(`- Async job — ${bits.join(" · ")}`);
  }
  if (e.inputSchema && Object.keys(e.inputSchema).length) lines.push(`- Input schema:\n${fence(e.inputSchema)}`);
  if (e.outputSchema && Object.keys(e.outputSchema).length) lines.push(`- Output schema:\n${fence(e.outputSchema)}`);
  return lines.join("\n");
}

function serviceMd(s: BundleService): string {
  const lines: string[] = [];
  lines.push(`### ${s.name}  \`${s.id}\``);
  if (s.description) lines.push(s.description);
  lines.push(`- Category: ${s.category} · Kind: ${s.kind} · Headline: ${s.pricing}`);
  if (s.tags.length) lines.push(`- Tags: ${s.tags.join(", ")}`);
  lines.push("");
  if (s.endpoints.length) {
    lines.push(`**Endpoints (${s.endpoints.length})**`);
    for (const e of s.endpoints) {
      lines.push("");
      lines.push(endpointMd(e));
    }
  } else {
    lines.push("_No payable endpoint published for this service._");
  }
  if (s.usage) {
    lines.push("");
    lines.push(`**How to use** (${s.usage.status}${s.usage.resultPull !== "none" ? ` · result: ${s.usage.resultPull}` : ""}${s.usage.auth === "siwx" ? " · auth: SIWX" : ""})`);
    if (s.usage.guide) lines.push(s.usage.guide);
    if (s.usage.callShape) lines.push(`- Call: ${s.usage.callShape}`);
    if (s.usage.outputShape) lines.push(`- Output location: \`${s.usage.outputShape}\``);
    if (s.usage.inputExample && Object.keys(s.usage.inputExample).length) lines.push(`- Example input:\n${fence(s.usage.inputExample)}`);
    for (const q of s.usage.quirks) lines.push(`- Quirk: ${q}`);
  }
  if (s.docs) {
    const d = [s.docs.llmTxt && `llms.txt: ${s.docs.llmTxt}`, s.docs.agentMd && `agent.md: ${s.docs.agentMd}`, s.docs.openapi && `openapi: ${s.docs.openapi}`].filter(Boolean);
    if (d.length) lines.push(`- Docs: ${d.join(" · ")}`);
  }
  return lines.join("\n");
}

/** Readable Markdown reference of the whole bundle — the copy-to-clipboard payload and the brain's context. */
export function bundleToMarkdown(bundle: ServiceBundle): string {
  const out: string[] = [];
  out.push(`# Masterkey Service Bundle`);
  out.push(`${bundle.count} service${bundle.count === 1 ? "" : "s"} · exported from ${bundle.source}`);
  out.push("");
  out.push(bundle.notes);
  out.push("");
  out.push("---");
  for (const s of bundle.services) {
    out.push("");
    out.push(serviceMd(s));
    out.push("");
    out.push("---");
  }
  return out.join("\n");
}
