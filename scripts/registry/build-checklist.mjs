/**
 * build-checklist.mjs — the authoritative, endpoint-granular QA checklist (the backbone of the run).
 *
 * The registry models every service as `backends[]` (a model served by N gateways → N backends; an API
 * with N operations → N backend URLs). The true testable universe is therefore one row PER BACKEND
 * (~709), not per service (364). This script enumerates all of them and joins QA status so we always
 * know exactly what's tested, what's left, and never pay for the same endpoint twice.
 *
 * Sources (read):
 *   data/registry/by-subcat/*.json   — full Service[] incl. backends[]
 *   data/registry/qa-checklist.json  — prior endpoint-level QA status (preserved across rebuilds)
 *   data/registry/qa-ledger.json     — legacy service-level ledger (seeds initial status by testedUrl)
 *
 * Outputs (write):
 *   data/registry/qa-checklist.json  — machine source of truth: one row per endpoint, with status
 *   REGISTRY_QA_CHECKLIST.md         — human view: progress counts + per-subcategory endpoint rows
 *
 * Status per endpoint ∈ "verified" | "broken" | "over-cap" | "needs-input" | "todo".
 * Idempotent: re-run anytime; existing qa-checklist statuses win, ledger only seeds untouched rows.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const BY_SUBCAT = path.join(ROOT, "data/registry/by-subcat");
const CHECKLIST_JSON = path.join(ROOT, "data/registry/qa-checklist.json");
const LEDGER_JSON = path.join(ROOT, "data/registry/qa-ledger.json");
const CHECKLIST_MD = path.join(ROOT, "REGISTRY_QA_CHECKLIST.md");

// Outward / irreversible subcategories: a real call here DOES something in the world (sends, charges,
// publishes, ships). Flagged so the QA workflow routes them through approval + uses the user's contact,
// and Phase B re-pay is handled deliberately. A hint, not a hard rule — the agent confirms per endpoint.
const OUTWARD_SUBCATS = new Set([
  "email",
  "sms-phone",
  "video-voice-calls",
  "push-notifications",
  "e-signature",
  "payment-processing",
  "crypto-web3-payments",
  "storefront-commerce-apis",
  "live-chat-messaging",
  "invoicing",
  "survey-feedback",
]);

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Confident match: does a ledger `testedUrl` correspond to THIS specific backend url? Handles `:param`
 * templates (e.g. /postal-code/:zip vs /postal-code/1000001). Deliberately STRICT for multi-backend
 * services: we require same host AND a real (non-root) static path prefix to match, so one tested
 * endpoint never marks its untested siblings as done. Under-marking (→ retest, costs cents) is safe;
 * over-marking (→ silently skip an untested endpoint) is not.
 */
function urlMatchesBackend(testedUrl, backendUrl) {
  if (!testedUrl || !backendUrl) return false;
  try {
    const t = new URL(testedUrl);
    const b = new URL(backendUrl);
    if (t.hostname !== b.hostname) return false;
    const staticPrefix = b.pathname.split("/").filter((s) => !s.startsWith(":")).join("/");
    if (staticPrefix.length <= 1) return false; // root-only path → not specific enough to disambiguate
    return t.pathname.startsWith(staticPrefix);
  } catch {
    return testedUrl === backendUrl;
  }
}

function mapLedgerStatus(s) {
  if (s === "verified") return "verified";
  if (s === "broken") return "broken";
  if (s === "over-cap") return "over-cap";
  if (s === "needs-input" || s === "untested") return "todo";
  return "todo";
}

// --- gather ----------------------------------------------------------------------------------------

const prior = readJson(CHECKLIST_JSON, null);
const priorByKey = new Map();
if (prior?.endpoints) for (const e of prior.endpoints) priorByKey.set(e.key, e);

const ledger = readJson(LEDGER_JSON, { services: {} }).services || {};

const endpoints = [];
const files = fs.readdirSync(BY_SUBCAT).filter((f) => f.endsWith(".json")).sort();

for (const file of files) {
  const services = readJson(path.join(BY_SUBCAT, file), []);
  for (const svc of services) {
    const backends = Array.isArray(svc.backends) ? svc.backends : [];
    // A service with zero backends still gets one row so it isn't invisible (shouldn't happen: 0 found).
    const rows = backends.length ? backends : [{ url: null, method: null }];
    rows.forEach((b, i) => {
      const key = `${svc.id}#${i}`;
      const ledgerEntry = ledger[svc.id];

      // Seed status: prior checklist wins (preserves QA progress); else ledger by url-match.
      let status = "todo";
      let testedAt = null;
      let costUsd = null;
      let testedVia = null;
      let notes = null;

      const priorRow = priorByKey.get(key);
      if (priorRow && priorRow.status && priorRow.status !== "todo") {
        status = priorRow.status;
        testedAt = priorRow.testedAt ?? null;
        costUsd = priorRow.costUsd ?? null;
        testedVia = priorRow.testedVia ?? "qa-checklist";
        notes = priorRow.notes ?? null;
      } else if (ledgerEntry) {
        const single = backends.length <= 1;
        const matches = single || urlMatchesBackend(ledgerEntry.testedUrl, b.url);
        if (matches) {
          status = mapLedgerStatus(ledgerEntry.status);
          testedAt = ledgerEntry.testedAt ?? null;
          costUsd = ledgerEntry.costUsd ?? null;
          testedVia = "ledger";
          notes = single ? null : "matched to ledger by url/host";
        }
      }

      endpoints.push({
        key,
        serviceId: svc.id,
        name: svc.name,
        kind: svc.kind,
        category: svc.category,
        subcategory: svc.subcategory,
        provider: b.provider ?? svc.provider ?? null,
        url: b.url ?? null,
        method: b.method ?? null,
        authMode: b.authMode ?? null,
        priceDisplay: b.price?.display ?? svc.pricing?.headline ?? null,
        priceAmount: b.price?.amount ?? svc.pricing?.amount ?? null,
        modelParam: b.modelParam ?? null,
        outward: OUTWARD_SUBCATS.has(svc.subcategory) || svc.usage?.needsApproval === true,
        backendStatus: b.status ?? null, // registry's own active/needs-review flag
        serviceStatus: svc.status ?? null,
        status,
        testedAt,
        costUsd,
        testedVia,
        notes,
      });
    });
  }
}

// stable order: category → subcategory → service → backend index
endpoints.sort((a, b) =>
  (a.category || "").localeCompare(b.category || "") ||
  (a.subcategory || "").localeCompare(b.subcategory || "") ||
  (a.serviceId || "").localeCompare(b.serviceId || "") ||
  a.key.localeCompare(b.key),
);

// --- totals ----------------------------------------------------------------------------------------

const countBy = (pred) => endpoints.filter(pred).length;
const totals = {
  endpoints: endpoints.length,
  services: new Set(endpoints.map((e) => e.serviceId)).size,
  verified: countBy((e) => e.status === "verified"),
  broken: countBy((e) => e.status === "broken"),
  needsReview: countBy((e) => e.status === "needs-review"),
  needsInput: countBy((e) => e.status === "needs-input"),
  overCap: countBy((e) => e.status === "over-cap"),
  todo: countBy((e) => e.status === "todo"),
  outward: countBy((e) => e.outward),
  free: countBy((e) => e.authMode === "free" || e.priceAmount === 0),
};

const generatedAt = new Date().toISOString();
fs.writeFileSync(CHECKLIST_JSON, JSON.stringify({ generatedAt, totals, endpoints }, null, 2));

// --- markdown view ---------------------------------------------------------------------------------

const ICON = { verified: "✅", broken: "❌", "needs-review": "🔶", "over-cap": "💰", "needs-input": "⏸️", todo: "⬜" };
const tested = totals.verified + totals.broken;
let md = `# Registry QA — Master Checklist (endpoint-granular)\n\n`;
md += `> Source of truth: \`data/registry/qa-checklist.json\`. Regenerate with \`node scripts/registry/build-checklist.mjs\`.\n\n`;
md += "```\n";
md += `Endpoints: ${totals.endpoints}  (across ${totals.services} services)\n`;
md += `Tested:    ${tested}   (✅ ${totals.verified} verified · ❌ ${totals.broken} broken · 🔶 ${totals.needsReview} needs-review · 💰 ${totals.overCap} over-cap)\n`;
md += `Remaining: ${totals.todo} todo\n`;
md += `Outward:   ${totals.outward} endpoints flagged outward/irreversible\n`;
md += `Generated: ${generatedAt}\n`;
md += "```\n\n";

// --- REVISIT BACKLOG (everything left to do later: over-cap, deferred, transient) -----------------
// These are NOT failures — they are endpoints we intentionally parked and can call later.
const backlog = endpoints.filter((e) => ["over-cap", "needs-input", "needs-review"].includes(e.status));
if (backlog.length) {
  md += `## ⏳ Revisit backlog — ${backlog.length} endpoints parked for later (not dropped)\n\n`;
  md += `> Re-run any of these with: \`node scripts/registry/next-batch.mjs --ids="<key1>,<key2>"\` → feed to the workflow. Over-cap needs your $ approval; deferred needs your OK/details; wrong-currency needs the chain funded.\n\n`;
  const groups = [
    ["💰 over-cap (quote > $10 ceiling — needs your $ approval)", (e) => e.status === "over-cap"],
    ["🕷️ Apify actors — indexed, untested ($1/call flat via x402 — test on demand; see APIFY_BACKLOG.md)", (e) => e.status === "needs-input" && /APIFY-BACKLOG/.test(e.notes || "")],
    ["⏸️ deferred — irreversible purchase / money-mover (needs your OK + details)", (e) => e.status === "needs-input" && /DEFERRED/.test(e.notes || "")],
    ["🌐 wrong-currency — endpoint wants Solana/Polygon/other USDC we don't hold (needs that chain funded)", (e) => e.status === "needs-input" && /(solana|polygon|chain|currency|no compatible)/i.test(e.notes || "")],
    ["🧩 needs-input — other (missing creds/key, binary upload, unresolved template, missing resource)", (e) => e.status === "needs-input" && !/DEFERRED/.test(e.notes || "") && !/APIFY-BACKLOG/.test(e.notes || "") && !/(solana|polygon|chain|currency|no compatible)/i.test(e.notes || "")],
    ["🔶 needs-review — transient failure (host down / 5xx) — re-test before relying", (e) => e.status === "needs-review"],
  ];
  const seen = new Set();
  for (const [title, pred] of groups) {
    const rows = backlog.filter((e) => pred(e) && !seen.has(e.key));
    if (!rows.length) continue;
    rows.forEach((r) => seen.add(r.key));
    md += `### ${title}  (${rows.length})\n\n`;
    md += `| Key | Price | Endpoint | Why parked |\n|---|---|---|---|\n`;
    for (const r of rows) md += `| \`${r.key}\` | ${r.priceDisplay ?? "—"} | \`${r.url ?? "—"}\` | ${(r.notes || "").replace(/\|/g, "/").slice(0, 100)} |\n`;
    md += `\n`;
  }
}

// group by subcategory
const bySub = new Map();
for (const e of endpoints) {
  const k = `${e.category} / ${e.subcategory}`;
  if (!bySub.has(k)) bySub.set(k, []);
  bySub.get(k).push(e);
}

for (const [sub, rows] of bySub) {
  const done = rows.filter((r) => r.status === "verified" || r.status === "broken").length;
  md += `## ${sub}  \`${done}/${rows.length}\`\n\n`;
  md += `| Status | Service | Provider | Method | Endpoint | Price | Flags |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const icon = ICON[r.status] || "⬜";
    const flags = [
      r.outward ? "outward" : "",
      r.modelParam ? `model:${r.modelParam.value ?? r.modelParam.name ?? "y"}` : "",
      r.backendStatus && r.backendStatus !== "active" ? r.backendStatus : "",
      r.authMode === "siwx" ? "siwx" : "",
    ].filter(Boolean).join(" ");
    const ep = r.url ? `\`${r.url}\`` : "—";
    md += `| ${icon} | ${r.name} | ${r.provider ?? "—"} | ${r.method ?? "—"} | ${ep} | ${r.priceDisplay ?? "—"} | ${flags} |\n`;
  }
  md += `\n`;
}

fs.writeFileSync(CHECKLIST_MD, md);

console.log(JSON.stringify(totals, null, 2));
console.log(`\nWrote:\n  ${path.relative(ROOT, CHECKLIST_JSON)}\n  ${path.relative(ROOT, CHECKLIST_MD)}`);
