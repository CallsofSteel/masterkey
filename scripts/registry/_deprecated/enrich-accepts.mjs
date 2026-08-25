// ⛔ DEPRECATED 2026-07-16 — DO NOT RUN. Writes accepts directly into data/registry/by-subcat/*.json, which curate.mjs regenerates — so its edits get wiped (drift source). Superseded by enrich-accepts-durable.mjs, which writes accepts to the SOURCE (curation/candidates).
// Kept for reference only. See MASTERKEY_HANDOFF.md (registry drift fix) + scripts/registry/verify-drift.mjs.
console.error("⛔ enrich-accepts.mjs is DEPRECATED and disabled (it caused/enabled registry drift). See MASTERKEY_HANDOFF.md.");
process.exit(1);

/* ----- original source below (never executes) -----
// GAP-2 re-enrich: backfill empty `payment.accepts[]` on shipped backends.
//
// Why: the original pipeline (core.mjs) only decoded the base64 `payment-required`
// HEADER, but most x402 v1 endpoints return their `accepts` in the JSON BODY. So many
// backends shipped with probe.payable=true (a 402 fired) yet payment.accepts=[] —
// missing the network/asset/amount/payTo an agent needs to actually pay. This re-probes
// each empty backend live and reads `accepts` from header AND body.
//
// Safe: x402/auth gates return 402/401 BEFORE the handler runs, so an empty body never
// triggers a real side effect on paid POST/PUT/DELETE ops.
//
// Usage:
//   node scripts/registry/enrich-accepts.mjs            # all subcats, write
//   node scripts/registry/enrich-accepts.mjs --dry-run  # probe + report, write nothing
//   node scripts/registry/enrich-accepts.mjs --subcat=email [--subcat=...]
//   node scripts/registry/enrich-accepts.mjs --cap=8    # concurrency (default 6)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/registry/by-subcat");
const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const getAll = (k) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.split("=")[1]);
const DRY = has("dry-run");
const CAP = Number((getAll("cap")[0]) || 3);     // low concurrency — bursts cause false timeouts/rate-limits
const TIMEOUT = Number((getAll("timeout")[0]) || 20000);
const TRIES = Number((getAll("tries")[0]) || 3); // retries per method on transient errors
const NOW = new Date().toISOString();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const onlySubs = getAll("subcat");
const files = readdirSync(OUT).filter((f) => f.endsWith(".json"))
  .filter((f) => !onlySubs.length || onlySubs.includes(f.replace(/\.json$/, "")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaw(url, method, probeBody) {
  const isBody = ["POST", "PUT", "PATCH"].includes(method);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      // RUN_RELIABILITY_SPEC 5.2: multi-model gateways (e.g. BlockRun) return a MODEL-DEPENDENT 402, so
      // an empty `{}` body can yield empty/wrong accepts. Probe with a model-correct body when known.
      body: isBody ? JSON.stringify(probeBody && Object.keys(probeBody).length ? probeBody : {}) : null,
      headers: { "User-Agent": UA, "Accept": "application/json", ...(isBody ? { "Content-Type": "application/json" } : {}) },
      redirect: "manual",
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    return { status: null, headers: new Headers(), text: "", error: String(e?.name || e) };
  } finally {
    clearTimeout(t);
  }
}

// Pull an accepts[] out of a 402 — header (base64 JSON) first, then JSON body.
function extractAccepts({ headers, text }) {
  // 1. payment-required header (base64-encoded JSON challenge)
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === "payment-required" && v) {
      try {
        const pr = JSON.parse(Buffer.from(v, "base64").toString("utf8"));
        const a = pr?.accepts || pr?.paymentRequirements;
        if (Array.isArray(a) && a.length) return a;
      } catch { /* fall through to body */ }
    }
  }
  // 2. JSON body (x402 v1: { x402Version, accepts: [...] } or { paymentRequirements: [...] })
  if (text) {
    try {
      const b = JSON.parse(text);
      const a = b?.accepts || b?.paymentRequirements || b?.data?.accepts;
      if (Array.isArray(a) && a.length) return a;
    } catch { /* not JSON */ }
  }
  return null;
}

// Normalize one challenge entry into our PaymentOption shape. Handles both the newer
// `amount` field and the x402 v1 `maxAmountRequired` field. Network kept verbatim (an x402
// client matches on the exact identifier the endpoint returns — "base" or "eip155:8453").
function normAccept(a) {
  if (!a || typeof a !== "object") return null;
  const amt = a.amount ?? a.maxAmountRequired;
  const out = { scheme: a.scheme || "exact", network: a.network ?? "", amount: amt != null ? String(amt) : "", asset: a.asset ?? "" };
  if (a.payTo != null) out.payTo = a.payTo;
  if (a.maxTimeoutSeconds != null) out.maxTimeoutSeconds = a.maxTimeoutSeconds;
  if (a.extra != null) out.extra = a.extra;
  return (out.amount && out.asset) ? out : null;
}

// Probe one method with retries. Returns the first useful outcome, retrying ONLY on
// transient failures (network err / timeout / 429 / 5xx) — never on definitive 4xx.
async function probeMethod(url, method, probeBody) {
  let last = { status: null };
  for (let i = 0; i < TRIES; i++) {
    const r = await fetchRaw(url, method, probeBody);
    last = r;
    if (r.status === 402) {
      const acc = extractAccepts(r);
      return { kind: acc ? "filled" : "payable", method, accepts: acc ? acc.map(normAccept).filter(Boolean) : [] };
    }
    if (r.status >= 200 && r.status < 300) return { kind: "free", method, accepts: [] };
    // definitive (no point retrying): real auth/dead/method-not-allowed/bad-request
    if ([400, 401, 403, 404, 405, 410].includes(r.status)) return { kind: "hard", status: r.status, method, accepts: [] };
    await sleep(500 * (i + 1)); // transient (err/timeout/429/5xx) → back off and retry
  }
  return { kind: "soft", status: last.status, method, accepts: [] }; // exhausted retries — treat as blocked
}

// Probe order: backend's recorded method first, then GET/POST fallback. Best verdict wins:
// filled > payable(402, no parseable accepts) > free > hard(401/403/404…) > soft(blocked/timeout).
const RANK = { filled: 5, payable: 4, free: 3, hard: 2, soft: 1 };
async function reprobe(url, method, probeBody) {
  const order = [];
  const m0 = (method || "POST").toUpperCase();
  if (m0 !== "OPTIONS" && m0 !== "HEAD") order.push(m0);
  for (const m of ["POST", "GET"]) if (!order.includes(m)) order.push(m);
  let best = { kind: "soft", status: null, method: order[0], accepts: [] };
  for (const m of order) {
    const r = await probeMethod(url, m, probeBody);
    if (RANK[r.kind] > RANK[best.kind]) best = r;
    if (r.kind === "filled") break; // got what we came for
    await sleep(150);
  }
  return best;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// Collect every backend with empty accepts across the selected subcats.
const jobs = [];
const data = {};
for (const f of files) {
  const svcs = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  data[f] = svcs;
  for (const s of svcs) for (const b of (s.backends || [])) {
    const acc = b.payment?.accepts || [];
    // re-probe if no accepts at all, OR any accept lacks a usable amount/asset (malformed)
    const malformed = acc.some((a) => !a.amount || !a.asset || !a.network);
    if (acc.length === 0 || malformed) jobs.push({ f, svc: s.name, backend: b });
  }
}

console.log(`enrich-accepts: ${jobs.length} empty-accepts backends across ${files.length} subcats · cap ${CAP}${DRY ? " · DRY-RUN" : ""}`);

let filled = 0, fillsAccepts = 0, payableNoAcc = 0, free = 0, hard = 0, soft = 0, downgraded = 0;
const results = await pool(jobs, CAP, async (j) => {
  const b = j.backend;
  // 5.2: a multi-model gateway prices the 402 per model → probe with the backend's modelParam in the body.
  const probeBody = b.modelParam?.name ? { [b.modelParam.name]: b.modelParam.value } : {};
  const r = await reprobe(b.url, b.method, probeBody);
  return { j, r };
});

for (const { j, r } of results) {
  const b = j.backend;
  if (r.kind === "filled") {
    if (!b.payment) b.payment = { protocols: ["x402"], accepts: [] };
    b.payment.accepts = r.accepts;
    b.probe = { ...(b.probe || {}), status: 402, method: r.method, payable: true, free: false, blocked: false, checkedAt: NOW };
    filled++; fillsAccepts += r.accepts.length;
    console.log(`  ✓ ${j.svc.padEnd(26)} ${b.provider.padEnd(14)} ${r.accepts.length} accepts  ${b.url}`);
  } else if (r.kind === "payable") {
    // confirmed 402 but accepts not parseable — keep payable, leave accepts empty
    b.probe = { ...(b.probe || {}), status: 402, method: r.method, payable: true, checkedAt: NOW };
    payableNoAcc++;
    console.log(`  ~ ${j.svc.padEnd(26)} ${b.provider.padEnd(14)} 402 (accepts unparseable)  ${b.url}`);
  } else if (r.kind === "free") {
    free++;
    console.log(`  · ${j.svc.padEnd(26)} ${b.provider.padEnd(14)} free 2xx (no accepts)  ${b.url}`);
  } else if (r.kind === "hard") {
    // definitive non-payable (401/403/404/…) → if it was claiming active, downgrade
    hard++;
    if (b.status === "active" && !(b.probe && b.probe.free)) { b.status = "needs-review"; downgraded++; }
    console.log(`  ✗ ${j.svc.padEnd(26)} ${b.provider.padEnd(14)} ${r.status} (definitive)  ${b.url}`);
  } else {
    // soft/blocked (timeout/5xx/429) — per SPEC, a blocked probe never overrides payment
    // evidence. Leave status + accepts untouched; recoverable on a later run.
    soft++;
    console.log(`  ? ${j.svc.padEnd(26)} ${b.provider.padEnd(14)} ${r.status ?? "err"} (blocked — kept)  ${b.url}`);
  }
}

if (!DRY) {
  for (const f of files) writeFileSync(join(OUT, f), JSON.stringify(data[f], null, 2));
}

console.log(`\n--- summary ---`);
console.log(`  filled w/ accepts:        ${filled} (${fillsAccepts} payment options)`);
console.log(`  402 but unparseable:      ${payableNoAcc} (kept payable)`);
console.log(`  free 2xx:                 ${free}`);
console.log(`  definitive non-payable:   ${hard} (downgraded active→needs-review: ${downgraded})`);
console.log(`  blocked/transient (kept): ${soft}`);
console.log(DRY ? `\n  (dry-run — nothing written)` : `\n  wrote ${files.length} by-subcat files`);

*/
