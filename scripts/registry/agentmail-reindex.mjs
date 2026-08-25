#!/usr/bin/env node
/**
 * agentmail-reindex.mjs — reconcile the curated AgentMail multi-op service against
 * the provider's CURRENT surface (openapi.json) + a live unpaid probe of the x402 base.
 *
 * Why this exists: `enrich-accepts-durable.mjs` only backfills `backends[]`; AgentMail is an
 * api-kind service whose whole surface lives in `operations[]`, so it needs its own harness.
 *
 * What it does (all FREE — unpaid probes only, no X-PAYMENT header is ever sent):
 *   1. Probes every op (kept + candidate) on https://x402.api.agentmail.to
 *      - 402 -> route live + payable; capture `accepts` + amount from the live quote
 *      - 403 -> route live but ownership-gated BEFORE payment (verified: fires for both an
 *               owned and a nonexistent inbox), so no quote is obtainable unpaid -> clone the
 *               canonical read accepts (amount 0) and record the honest 403 probe
 *      - 404 -> route is DEAD -> drop it
 *   2. Rewrites the AgentMail entry's operations[] in scripts/registry/curation/email.json.
 *
 * Op names must be UNIQUE: run.ts:236 selects an operation by exact `name`, so a duplicate
 * would make the second one permanently unreachable (the §5.5 silent-drop trap).
 *
 * Usage: node scripts/registry/agentmail-reindex.mjs [--write]   (default = dry run)
 */
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
const BASE = "https://x402.api.agentmail.to";
const OPENAPI = "./openapi.json";
const CURATION = path.join(process.cwd(), "scripts/registry/curation/email.json");
const TODAY = "2026-07-26";
// A real inbox owned by the master wallet — used only to shape probe URLs.
const PROBE_INBOX = encodeURIComponent("powerfulrule82@agentmail.to");

/**
 * path -> the display name we index it under. Absent = deliberately NOT indexed.
 *
 * Deliberately excluded: /v0/api-keys/* and /v0/organizations are API-KEY-plane endpoints
 * (account management for the Bearer-token API at api.agentmail.to), not x402 ones — we index
 * x402 only. Both 404 on the x402 base, which confirms it.
 */
const NAMES = {
  // ---- org / account scope -------------------------------------------------
  "GET /v0/inboxes": "List Inboxes",
  "POST /v0/inboxes": "Create Inbox",
  "GET /v0/inboxes/{inbox_id}": "Get Inbox",
  "PATCH /v0/inboxes/{inbox_id}": "Update Inbox",
  "DELETE /v0/inboxes/{inbox_id}": "Delete Inbox",
  "GET /v0/domains": "List Domains",
  "POST /v0/domains": "Create Domain",
  "GET /v0/domains/{domain_id}": "Get Domain",
  "PATCH /v0/domains/{domain_id}": "Update Domain",
  "DELETE /v0/domains/{domain_id}": "Delete Domain",
  "GET /v0/domains/{domain_id}/zone-file": "Get Zone File",
  "POST /v0/domains/{domain_id}/verify": "Verify Domain",
  "GET /v0/webhooks": "List Webhooks",
  "POST /v0/webhooks": "Create Webhook",
  "GET /v0/webhooks/{webhook_id}": "Get Webhook",
  "PATCH /v0/webhooks/{webhook_id}": "Update Webhook",
  "DELETE /v0/webhooks/{webhook_id}": "Delete Webhook",
  "GET /v0/drafts": "List Drafts (All Inboxes)",
  "GET /v0/drafts/{draft_id}": "Get Draft (All Inboxes)",
  "GET /v0/threads": "List Threads (All Inboxes)",
  "GET /v0/threads/{thread_id}": "Get Thread (All Inboxes)",
  "GET /v0/threads/{thread_id}/attachments/{attachment_id}": "Get Thread Attachment (All Inboxes)",
  "GET /v0/metrics": "List Metrics (All Inboxes)",

  // ---- pods (inbox groups) -------------------------------------------------
  "GET /v0/pods": "List Pods",
  "POST /v0/pods": "Create Pod",
  "GET /v0/pods/{pod_id}": "Get Pod",
  "DELETE /v0/pods/{pod_id}": "Delete Pod",
  "GET /v0/pods/{pod_id}/inboxes": "List Pod Inboxes",
  "POST /v0/pods/{pod_id}/inboxes": "Create Pod Inbox",
  "GET /v0/pods/{pod_id}/inboxes/{inbox_id}": "Get Pod Inbox",
  "DELETE /v0/pods/{pod_id}/inboxes/{inbox_id}": "Delete Pod Inbox",
  "GET /v0/pods/{pod_id}/domains": "List Pod Domains",
  "POST /v0/pods/{pod_id}/domains": "Create Pod Domain",
  "DELETE /v0/pods/{pod_id}/domains/{domain_id}": "Delete Pod Domain",
  "GET /v0/pods/{pod_id}/drafts": "List Pod Drafts",
  "GET /v0/pods/{pod_id}/drafts/{draft_id}": "Get Pod Draft",
  "GET /v0/pods/{pod_id}/threads": "List Pod Threads",
  "GET /v0/pods/{pod_id}/threads/{thread_id}": "Get Pod Thread",
  "GET /v0/pods/{pod_id}/threads/{thread_id}/attachments/{attachment_id}": "Get Pod Thread Attachment",

  // ---- inbox scope ---------------------------------------------------------
  "GET /v0/inboxes/{inbox_id}/metrics": "Get Inbox Metrics",
  "GET /v0/inboxes/{inbox_id}/messages": "List Messages",
  "GET /v0/inboxes/{inbox_id}/messages/search": "Search Messages",
  "GET /v0/inboxes/{inbox_id}/messages/{message_id}": "Get Message",
  "PATCH /v0/inboxes/{inbox_id}/messages/{message_id}": "Update Message",
  "GET /v0/inboxes/{inbox_id}/messages/{message_id}/raw": "Get Raw Message",
  "GET /v0/inboxes/{inbox_id}/messages/{message_id}/attachments/{attachment_id}": "Get Message Attachment",
  "POST /v0/inboxes/{inbox_id}/messages/send": "Send Message",
  "POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply": "Reply To Message",
  "POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply-all": "Reply All Message",
  "POST /v0/inboxes/{inbox_id}/messages/{message_id}/forward": "Forward Message",
  "GET /v0/inboxes/{inbox_id}/threads": "List Threads",
  "GET /v0/inboxes/{inbox_id}/threads/search": "Search Threads",
  "GET /v0/inboxes/{inbox_id}/threads/{thread_id}": "Get Thread",
  "DELETE /v0/inboxes/{inbox_id}/threads/{thread_id}": "Delete Thread",
  "GET /v0/inboxes/{inbox_id}/threads/{thread_id}/attachments/{attachment_id}": "Get Thread Attachment",
  "GET /v0/inboxes/{inbox_id}/drafts": "List Drafts",
  "POST /v0/inboxes/{inbox_id}/drafts": "Create Draft",
  "GET /v0/inboxes/{inbox_id}/drafts/{draft_id}": "Get Draft",
  "PATCH /v0/inboxes/{inbox_id}/drafts/{draft_id}": "Update Draft",
  "DELETE /v0/inboxes/{inbox_id}/drafts/{draft_id}": "Delete Draft",
  "GET /v0/inboxes/{inbox_id}/drafts/{draft_id}/attachments/{attachment_id}": "Get Draft Attachment",
  "POST /v0/inboxes/{inbox_id}/drafts/{draft_id}/send": "Send Draft",
  "GET /v0/inboxes/{inbox_id}/lists/{direction}/{type}": "List Allow/Block Entries",
  "POST /v0/inboxes/{inbox_id}/lists/{direction}/{type}": "Create Allow/Block Entry",
  "GET /v0/inboxes/{inbox_id}/lists/{direction}/{type}/{entry}": "Get Allow/Block Entry",
  "DELETE /v0/inboxes/{inbox_id}/lists/{direction}/{type}/{entry}": "Delete Allow/Block Entry",
};

/**
 * Outward email egress + billable-resource provisioning => code-enforced approval gate.
 * Domain creation is $10 live (the pre-2026-07-26 curation wrongly recorded it as free).
 */
const APPROVAL = new Set([
  "Send Message", "Reply To Message", "Reply All Message", "Forward Message", "Send Draft",
  "Create Inbox", "Create Pod Inbox", "Create Domain", "Create Pod Domain",
]);

/** Concrete values substituted into {placeholders} to make a probe URL. */
const SAMPLE = {
  inbox_id: PROBE_INBOX, message_id: "probe-msg", thread_id: "probe-thr", draft_id: "probe-draft",
  domain_id: "probe-dom", webhook_id: "probe-wh", pod_id: "probe-pod", attachment_id: "probe-att",
  direction: "inbound", type: "from", entry: "probe-entry",
};

const probeUrl = (p) => BASE + p.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] ?? "probe");

function decodeAccepts(headerVal, body) {
  for (const src of [headerVal, body]) {
    if (!src) continue;
    try {
      const json = typeof src === "string" && !src.trim().startsWith("{")
        ? JSON.parse(Buffer.from(src, "base64").toString("utf8"))
        : (typeof src === "string" ? JSON.parse(src) : src);
      const a = json?.accepts || json?.paymentRequirements;
      if (Array.isArray(a) && a.length) return a;
    } catch { /* try next source */ }
  }
  return null;
}

async function probe(method, apiPath) {
  const url = probeUrl(apiPath);
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual" });
    const text = await res.text().catch(() => "");
    const accepts = res.status === 402
      ? decodeAccepts(res.headers.get("payment-required"), text)
      : null;
    return { status: res.status, accepts };
  } catch (e) {
    return { status: 0, accepts: null, error: String(e?.message || e) };
  }
}

/** Flatten an OpenAPI operation into the curation inputSchema shape. */
function buildInputSchema(spec, apiPath, method) {
  const op = spec.paths?.[apiPath]?.[method.toLowerCase()];
  if (!op) return null;
  const out = {};
  const params = [...(spec.paths[apiPath].parameters || []), ...(op.parameters || [])];
  for (const raw of params) {
    const p = raw.$ref ? resolveRef(spec, raw.$ref) : raw;
    if (!p?.name) continue;
    const bucket = p.in === "path" ? "pathParams" : p.in === "query" ? "queryParams" : null;
    if (!bucket) continue;
    (out[bucket] ??= {})[p.name] = {
      type: p.schema?.type || "string",
      required: !!p.required,
      description: p.description || "",
    };
  }
  const bodySchemaRef = op.requestBody?.content?.["application/json"]?.schema;
  const bodySchema = bodySchemaRef?.$ref ? resolveRef(spec, bodySchemaRef.$ref) : bodySchemaRef;
  if (bodySchema?.properties) {
    out.body = {};
    for (const [k, v] of Object.entries(bodySchema.properties)) {
      out.body[k] = {
        type: v.type || "object",
        ...(Array.isArray(bodySchema.required) && bodySchema.required.includes(k) ? { required: true } : {}),
        description: v.description || "",
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

function resolveRef(spec, ref) {
  return ref.replace(/^#\//, "").split("/").reduce((acc, k) => acc?.[k], spec);
}

const main = async () => {
  const spec = JSON.parse(fs.readFileSync(OPENAPI, "utf8"));
  const curation = JSON.parse(fs.readFileSync(CURATION, "utf8"));
  const am = curation.entries.find((e) => e.name === "AgentMail");
  if (!am) throw new Error("AgentMail entry not found in curation/email.json");

  // Index the existing curated ops by "METHOD /path" so we can preserve hand-written usage blocks.
  const existing = new Map();
  for (const op of am.operations || []) {
    existing.set(`${op.method.toUpperCase()} ${decodeURIComponent(new URL(op.url).pathname)}`, op);
  }

  // Candidate set = the union of (what the provider's OpenAPI declares) and (what we already index).
  const candidates = new Set(Object.keys(NAMES));
  for (const k of existing.keys()) candidates.add(k);

  const canonicalAccepts = existing.get("GET /v0/domains")?.payment?.accepts
    ?? am.operations?.[0]?.payment?.accepts;

  const kept = [], dropped = [], added = [];
  for (const key of [...candidates].sort()) {
    const [method, apiPath] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    const name = NAMES[key];
    const prev = existing.get(key);

    const { status, accepts, error } = await probe(method, apiPath);

    if (!name) {
      // Currently indexed but absent from the provider's OpenAPI — confirm with the live probe
      // rather than asserting it, so the drop is evidence-based.
      dropped.push({
        key,
        name: prev?.name,
        reason: status === 404
          ? "404 — route dead on the x402 base (absent from provider OpenAPI, confirmed by live probe)"
          : `absent from provider OpenAPI but probe returned ${status} — REVIEW before dropping`,
      });
      continue;
    }

    if (status === 404 || status === 0) {
      dropped.push({ key, name, reason: error ? `probe failed: ${error}` : "404 — route dead on x402 base" });
      continue;
    }

    const liveAmount = accepts?.[0]?.amount != null ? Number(accepts[0].amount) / 1e6 : null;
    const amount = liveAmount ?? (prev ? prev.price.amount : 0);
    const gated = status === 403;

    const op = {
      name,
      method,
      url: BASE + apiPath,
      price: {
        amount,
        currency: "USD",
        unit: "per call",
        display: amount === 0 ? "Free" : `$${amount.toFixed(4)}`,
        source: gated
          ? "ownership-gated (403 before 402) — reads free at base; a $2/mo/inbox storage debt is surcharged onto the next op until cleared"
          : `live-402 (${TODAY}); a $2/mo/inbox storage debt is surcharged onto the next op until cleared`,
      },
      authMode: "x402",
      probe: {
        status,
        method,
        payable: true,
        free: amount === 0,
        checkedAt: TODAY,
        note: gated
          ? "403 'Ownership required' fires BEFORE the 402 for inbox/pod-scoped ops (verified for both an owned and a nonexistent inbox), so no unpaid quote is obtainable; accepts cloned from a sibling read op. At runtime the paying wallet is the owner, so the call proceeds."
          : `x402 402 confirmed ${TODAY} on the x402 base (${BASE})`,
      },
      inputSchema: buildInputSchema(spec, apiPath, method) ?? prev?.inputSchema ?? null,
      outputSchema: prev?.outputSchema ?? null,
      instructions: prev?.instructions ?? null,
      payment: { protocols: ["x402"], accepts: accepts ?? prev?.payment?.accepts ?? canonicalAccepts },
      ...(APPROVAL.has(name) ? { needsApproval: true } : {}),
      ...(prev?.usage ? { usage: prev.usage } : {}),
    };

    kept.push(op);
    if (!prev) added.push(`${name}  (${key})`);
  }

  // Guard: op names must be unique — run.ts selects by exact name.
  const names = kept.map((o) => o.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) throw new Error(`duplicate operation names would be unreachable: ${dupes.join(", ")}`);

  console.log(`\n=== ADDED (${added.length}) ===`);
  added.forEach((a) => console.log("  +", a));
  console.log(`\n=== DROPPED (${dropped.length}) ===`);
  dropped.forEach((d) => console.log("  -", d.name || "(uncurated)", "|", d.key, "|", d.reason));
  console.log(`\n=== TOTALS === before: ${am.operations.length}  after: ${kept.length}`);
  const paid = kept.filter((o) => o.price.amount > 0);
  console.log("paid ops:", paid.map((o) => `${o.name} $${o.price.amount}`).join(", ") || "(none)");
  console.log("approval-gated:", kept.filter((o) => o.needsApproval).map((o) => o.name).join(", "));
  console.log("probe status mix:", JSON.stringify(kept.reduce((a, o) => (a[o.probe.status] = (a[o.probe.status] || 0) + 1, a), {})));

  if (!WRITE) { console.log("\n(dry run — pass --write to apply)"); return; }
  am.operations = kept;
  fs.writeFileSync(CURATION, JSON.stringify(curation, null, 2) + "\n");
  console.log(`\n✓ wrote ${CURATION}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
