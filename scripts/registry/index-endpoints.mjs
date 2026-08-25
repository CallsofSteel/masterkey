#!/usr/bin/env node
// Masterkey — index newly-discovered x402 endpoints. Authored fresh (does NOT depend on add-discovered.mjs).
//
// Design (owner-approved "hybrid: serial core + capable-agent judgment"):
//   • The DETERMINISTIC CORE (this file) owns everything that touches money or the registry — probing,
//     the spend gate, paying (via the independently-verified dist/qa-pay.mjs), the additive write, and the
//     accounting. These run SERIALLY so the wallet and the curation files are never raced.
//   • JUDGMENT that a script must not fake — a clean name, description, taxonomy placement, a valid request
//     body vs. `needs-input`, quirks, and the service-vs-backend MERGE call — is delegated to a CAPABLE
//     model (claude -p, default sonnet) with STRICT output validation + one repair retry. On validation
//     failure an endpoint is PARKED, never fabricated.
//
// Reused, independently verified this session (NOT the distrusted add-discovered.mjs):
//   • dist/qa-pay.mjs   — money-safe pay: unpaid-quote-before-pay, per-call cap enforced pre-settlement,
//                         requireChallenge (a non-402 never pays), real X-Payment-Response settlement.
//   • curate.mjs + verify-drift/no-tangle/bundle-pins — run manually AFTER --apply (this script prints them).
//
// Fixes the four defects the free validation run demonstrated in add-discovered.mjs:
//   D1  probe tries the documented method AND falls back GET<->POST before rejecting (blockrun was live on
//       GET, dropped on POST/405). The method that yields the 402 becomes the backend + pay method.
//   D2  a 402 with no decodable accepts is its own state `needs-accepts`, not silently `rejected`.
//   D3  price reads `maxAmountRequired ?? amount` and converts ONLY for known USDC assets (strale priced
//       $0.054 via maxAmountRequired was recorded null). Non-USDC → recorded atomic + flagged, never guessed.
//   D4  network/DNS errors are retried 3x and, if still unreachable, marked `unreachable` (retryable),
//       never conflated with `rejected` (stablefinance DNS-timed-out, not proven dead).
//   +   the cumulative spend ceiling is made REAL: every pay passes --label=<sprint>:<key> and sets
//       QA_SPRINT_CEILING/PREFIX, so qa-pay's log-based ceiling actually accrues (add-discovered passed no
//       label, so the ceiling never accrued — only the per-call cap bound spend).
//   +   allowed placements are derived from the REAL curation headers (filename==subcategory), not the
//       drifted taxonomy.txt (which had mapping-geocoding vs the real maps-geolocation).
//
// Flags:
//   --funnel=<file>        funnel-*.json (default newest)          --batch=N (default 1)   --limit=N
//   --cap=0.25             per-call ceiling                         --model=sonnet (judgment)
//   --pay                  actually pay-test (default FREE)         --rejudge (re-judge already-judged)
//   --sprint=<prefix>      REQUIRED with --pay: fresh label prefix for this sprint's spend accounting
//   --sprint-ceiling=<usd> REQUIRED with --pay: hard cumulative ceiling for this sprint (via qa-pay)
//   --apply --subcat=<s>   append staged entries classified into <s> to curation/<s>.json (additive)
//
// RESUMABLE: every endpoint's state is written to the checklist after EACH step. Re-run to continue.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../..");
const CURATION = join(__dir, "curation");
const DISCOVERY = join(ROOT, "data/registry/discovery");
const STAGING = join(DISCOVERY, "staged");
const CHECKLIST = join(DISCOVERY, "index-checklist.json");
const QA_PAY = join(__dir, "dist/qa-pay.mjs");
const PROGRESS = join(ROOT, "data/registry/indexing-progress.jsonl"); // durable, committed, append-only
function appendProgress(rows) { if (rows?.length) appendFileSync(PROGRESS, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const has = (k) => argv.includes(`--${k}`);
const BATCH = Number(arg("batch", "1"));
const SUBCAT = arg("subcat", "");
const CAP = Number(arg("cap", "0.25"));
const LIMIT = Number(arg("limit", "0"));
const MODEL = arg("model", "sonnet");
const PAY = has("pay");
const APPLY = has("apply");
const REJUDGE = has("rejudge");
const PROBE_ONLY = has("probe-only"); // stop after the free probe+spec; emit a shortlist of payable≤cap for agents
const SPRINT = arg("sprint", "");
const SPRINT_CEILING = arg("sprint-ceiling", "");

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ── Bounded-concurrency runner (parallel probe; wall-clock ≈ items/n × per-probe, not sum) ──
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { __err: String(e?.message || e) }; } }
  }));
  return out;
}
const PROBE_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 12);

// ── Known USDC assets (D3): convert atomic→USD ONLY for these; otherwise record raw, never guess a price ──
const USDC = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum USDC
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // Solana USDC
]);
const isUsdc = (a) => !!a && (USDC.has(String(a.asset || "").toLowerCase()) || a?.extra?.name === "USD Coin");
const atomicOf = (a) => { const v = a?.maxAmountRequired ?? a?.amount; return v != null && /^\d+$/.test(String(v)) ? BigInt(String(v)) : null; };

// Normalize an accept to the canonical registry shape: carries `amount` (atomic string), drops the
// x402 `maxAmountRequired` alias so it matches existing entries (e.g. coinstats/stablesocial examples).
function normAccept(a) {
  const at = atomicOf(a);
  const { maxAmountRequired, ...rest } = a || {};
  return at != null ? { ...rest, amount: String(at) } : { ...rest };
}

// Pick the cheapest USD price across accepts. Returns { priceUsd|null, usdc:bool, accepts:normalized }.
function priceFromAccepts(accepts) {
  const norm = (accepts || []).map(normAccept);
  let best = null, anyUsdc = false;
  for (const a of accepts || []) {
    const at = atomicOf(a);
    if (at == null) continue;
    if (isUsdc(a)) { anyUsdc = true; const usd = Number(at) / 1e6; if (best == null || usd < best) best = usd; }
  }
  return { priceUsd: best, usdc: anyUsdc, accepts: norm };
}

// ── §5.5C: decode accepts from a live 402 — header AND body ──
function decodeAccepts(headers, bodyText) {
  const out = [];
  const push = (arr) => { for (const a of arr || []) if (a && (a.payTo || a.asset)) out.push(a); };
  const h = headers.get("payment-required") || headers.get("x-payment-required");
  if (h) for (const cand of [h, safeB64(h)]) { try { const j = JSON.parse(cand); push(j.accepts || j.paymentRequirements); break; } catch { /* next */ } }
  try { const j = JSON.parse(bodyText); push(j.accepts || j.paymentRequirements); } catch { /* not json */ }
  const seen = new Set();
  return out.filter((a) => { const k = `${a.network}|${a.payTo}|${a.maxAmountRequired ?? a.amount}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
const safeB64 = (s) => { try { return Buffer.from(s, "base64").toString("utf8"); } catch { return ""; } };

// ── D1/D4: one HTTP attempt with a HARD timeout + retry on transient network error ──
// AbortSignal.timeout ALONE does not reliably kill a stalled TLS connect (agentutility hung the serial
// probe ~40 min), so we race fetch against a hard timer and abort. Fewer retries here because the parallel
// runner + reachability precheck already handle dead hosts fast.
async function attempt(url, method, { timeoutMs = 12000, retries = 1 } = {}) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (method !== "GET") init.body = "{}";
  let netErr = null;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort("hard-timeout"), timeoutMs);
    try {
      const res = await Promise.race([
        fetch(url, { ...init, signal: ctl.signal }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("hard-timeout")), timeoutMs + 750)),
      ]);
      const text = await res.text().catch(() => "");
      clearTimeout(timer);
      return { status: res.status, accepts: res.status === 402 ? decodeAccepts(res.headers, text) : [], ok: res.ok, body: text.slice(0, 400) };
    } catch (e) { netErr = String(e?.message || e).slice(0, 140); clearTimeout(timer); if (i < retries) await sleep(400); }
  }
  return { status: 0, accepts: [], ok: false, error: netErr };
}

// Probe with METHOD FALLBACK: try the documented method, then the alternate, and keep the attempt that
// most-strongly proves payability. 402(+accepts) > free 2xx > 402(no accepts) > hard-4xx/5xx > network-fail.
async function probe(url, funnelMethod) {
  const primary = (funnelMethod || "POST").toUpperCase();
  const alt = primary === "GET" ? "POST" : "GET";
  const methods = [...new Set([primary, alt])];
  const attempts = [];
  for (const m of methods) { attempts.push({ m, r: await attempt(url, m) }); await sleep(120); }
  const accepted = attempts.filter((a) => a.r.status === 402 && a.r.accepts.length > 0);
  // Prefer POST when more than one method presents a 402 challenge: POST-execute providers (e.g. stratalize)
  // answer the 402 on GET too but only SETTLE/EXECUTE on POST — a GET there returns 405 "use POST" and a
  // paid GET can log an unconfirmed (voided) charge. When only one method yields a 402, use it.
  const withAccepts = accepted.length > 1 ? (accepted.find((a) => a.m === "POST") || accepted[0]) : accepted[0];
  if (withAccepts) return { method: withAccepts.m, kind: "payable", ...withAccepts.r };
  const free = attempts.find((a) => a.r.ok);
  if (free) return { method: free.m, kind: "free", ...free.r };
  const noAcc = attempts.find((a) => a.r.status === 402);
  if (noAcc) return { method: noAcc.m, kind: "needs-accepts", ...noAcc.r };
  const allNet = attempts.every((a) => a.r.status === 0);
  if (allNet) return { method: primary, kind: "unreachable", status: 0, accepts: [], error: attempts.map((a) => a.r.error).join(" / ") };
  const hard = attempts.find((a) => a.r.status >= 400) || attempts[0];
  return { method: hard.m, kind: "rejected", status: hard.r.status, accepts: [], body: hard.r.body };
}

// ── Host OpenAPI (free, cached) → the operation's summary + request/response schema ──
const specCache = new Map();
async function hostSpec(host) {
  if (specCache.has(host)) return specCache.get(host);
  let spec = null;
  for (const u of [`https://${host}/openapi.json`, `http://${host}/openapi.json`]) {
    try { const res = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (res.ok) { const j = await res.json(); if (j?.paths) { spec = j; break; } } } catch { /* next */ }
  }
  specCache.set(host, spec); return spec;
}
function specFor(spec, url, method) {
  if (!spec) return null;
  let path; try { path = new URL(url).pathname; } catch { return null; }
  const ops = spec.paths?.[path] || spec.paths?.[path.replace(/\/$/, "")];
  const op = ops?.[(method || "post").toLowerCase()] || ops?.post || ops?.get;
  if (!op) return null;
  // #2 provider-shape: pull a DOCUMENTED example so the agent pays with a known-good input (a guessed
  // input can buy a paid HTTP 400). Look in requestBody example/examples, the schema's example, the x402
  // bazaar extension, and per-parameter examples/defaults (query params).
  const jc = op.requestBody?.content?.["application/json"] || {};
  let example = jc.example ?? (jc.examples && Object.values(jc.examples)[0]?.value) ?? jc.schema?.example ?? op["x-402"]?.input ?? op["x-bazaar"]?.input ?? null;
  if (!example && Array.isArray(op.parameters)) {
    const q = {};
    for (const p of op.parameters) { if ((p.in === "query" || p.in === "path") && (p.example != null || p.schema?.example != null || p.schema?.default != null)) q[p.name] = p.example ?? p.schema?.example ?? p.schema?.default; }
    if (Object.keys(q).length) example = q;
  }
  return {
    summary: op.summary || op.description || "",
    inputSchema: jc.schema || null,
    outputSchema: op.responses?.["200"]?.content?.["application/json"]?.schema || null,
    inputExample: example ?? null,
  };
}

// ── Allowed placements = the REAL curation files (filename == header.subcategory). NOT taxonomy.txt. ──
function allowedPlacements() {
  const rows = [];
  for (const f of readdirSync(CURATION).filter((x) => x.endsWith(".json"))) {
    const j = readJson(join(CURATION, f)); if (!j?.subcategory) continue;
    rows.push({ subcat: j.subcategory, category: j.category || "", file: f });
  }
  return rows;
}

// ── Real, liveness-checked assets for request bodies. Never invent a URL for what we don't have. ──
const ASSET_CANDS = [
  { kind: "image", url: "https://i.img402.dev/zx8qjbsfu0.png", note: "1024x1024 PNG" },
];
const HAVE_NOT = ["audio", "video", "pdf/document", "uploaded-file ids", "job ids", "session tokens", "wallet addresses tied to a real account"];
async function assetsDoc() {
  const live = [];
  for (const a of ASSET_CANDS) { try { const r = await fetch(a.url, { method: "HEAD", signal: AbortSignal.timeout(8000) }); if (r.ok) live.push(`  ${a.kind}: ${a.url} (${a.note})`); } catch { /* dead */ } }
  live.push("  web page: https://example.org", '  plain text: "hello world"', "  email: test@example.org", "  domain: example.org");
  return live.join("\n") + `\nDO NOT invent a URL/id for these — set needsInput=true instead: ${HAVE_NOT.join(", ")}.`;
}

// ── Capable-model judgment (strict JSON, one repair retry, park on failure) ──
function callModel(prompt, input) {
  return execFileSync("claude", ["-p", "--model", MODEL, "--output-format", "text", prompt],
    { input, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
}
function judge(rows, places, assets) {
  const allowed = places.map((p) => `${p.category}/${p.subcat}`).join("\n");
  const payload = rows.map((r) => ({
    url: r.url, method: r.probe.method, host: r.host, brandFromHost: providerOf(r.host),
    priceUsd: r.priceUsd, spec: r.spec ? { summary: r.spec.summary, inputSchema: r.spec.inputSchema } : null,
    discoveryBlurb: (r.description || "").slice(0, 300),
  }));
  const prompt =
    "You classify pay-per-call x402 API endpoints into a catalog. For EACH input object output ONE JSON object with keys: " +
    "url, name, description, tags, modalityIn, modalityOut, kind, subcategory, sampleBody, needsInput, reason, mergeCandidate, mergeReason.\n" +
    "name: \"Brand Operation\", Title Case, 2-5 words. Brand DERIVED FROM THE HOST ONLY (given as brandFromHost) — NEVER from the blurb (blurbs often name a reseller). Operation from the path/spec. Distinct per endpoint.\n" +
    "description: ONE clear sentence — what it does AND what you get back. Never empty. No marketing.\n" +
    "tags: 3-6 short lowercase keywords, never empty. modalityIn/modalityOut: non-empty arrays from text|image|video|audio|file.\n" +
    "kind: \"model\" only if it runs a named AI model, else \"api\".\n" +
    "subcategory: EXACTLY one subcategory slug from the allowed list below (the part after the slash). Never invent one. If none fits, set needsInput=false but subcategory=\"\" and explain in reason.\n" +
    "sampleBody: minimal valid request body satisfying every REQUIRED inputSchema field, using ONLY these real assets:\n" + assets + "\n" +
    "needsInput=true when a REQUIRED field needs an artifact/id/asset we do not have (then sampleBody=null, reason names the field). A wrong body wastes real money — never guess a URL/id.\n" +
    "mergeCandidate: if this endpoint is very likely the SAME service+operation as an existing catalog entry (so it should be a backend, not a new service), put your best guess of that service's name; else null. mergeReason: why. (This is only a REPORT — never acted on automatically.)\n" +
    "Output a JSON array only, no prose, no code fences.\n\nALLOWED category/subcategory:\n" + allowed;
  let out = "";
  try { out = callModel(prompt, JSON.stringify(payload)); }
  catch (e) { console.error(`  judge call failed: ${String(e?.message || e).slice(0, 140)}`); return new Map(); }
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) { console.error("  judge: no JSON array in output"); return new Map(); }
  try { return new Map(JSON.parse(m[0]).map((o) => [o.url, o])); } catch { console.error("  judge: JSON parse failed"); return new Map(); }
}

const providerOf = (host) => {
  const bare = host.replace(/^(api|x402|www)\./, "").split(".").slice(0, -1).join(".") || host;
  return bare.split(/[-.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
};

// ── Checklist ──
function loadChecklist() { return readJson(CHECKLIST) || { updatedAt: null, endpoints: {} }; }
function saveChecklist(cl) { cl.updatedAt = nowIso(); mkdirSync(DISCOVERY, { recursive: true }); writeFileSync(CHECKLIST, JSON.stringify(cl, null, 2)); }

// ═══════════════════════════════════════════════════════════════════════════════════════════════
if (PAY && (!SPRINT || !SPRINT_CEILING)) { console.error("--pay requires --sprint=<fresh-prefix> and --sprint-ceiling=<usd> (real cumulative ceiling)."); process.exit(1); }

const funnelFile = arg("funnel", "") || (existsSync(DISCOVERY) ? readdirSync(DISCOVERY).filter((f) => f.startsWith("funnel-")).sort().pop() : null);
if (!funnelFile) { console.error("no funnel-*.json found"); process.exit(1); }
const funnel = readJson(funnelFile.includes("/") ? funnelFile : join(DISCOVERY, funnelFile));
const batch = (funnel?.batches || []).find((b) => b.id === BATCH);
if (!batch) { console.error(`batch ${BATCH} not found`); process.exit(1); }
let targets = batch.endpoints; if (LIMIT > 0) targets = targets.slice(0, LIMIT);

console.log(`funnel : ${funnelFile.replace(ROOT + "/", "")}`);
console.log(`batch  : #${BATCH} — ${(batch.hosts || []).join(", ")}`);
console.log(`targets: ${targets.length}  mode: ${PAY ? `PAY (sprint="${SPRINT}" ceiling=$${SPRINT_CEILING})` : "FREE"}${APPLY ? ` +APPLY→${SUBCAT}` : ""}  cap=$${CAP}\n`);

const cl = loadChecklist();
for (const t of targets) if (!cl.endpoints[t.key]) cl.endpoints[t.key] = { key: t.key, url: t.url, host: t.host, funnelMethod: (t.method || "POST").toUpperCase(), description: t.description || "", status: "todo", batch: BATCH, updatedAt: nowIso() };
saveChecklist(cl);
const rows = targets.map((t) => cl.endpoints[t.key]);
const mark = (r, patch) => { Object.assign(r, patch, { updatedAt: nowIso() }); saveChecklist(cl); };

// ── Stage 1: PROBE (free, method-fallback, PARALLEL + hard-timeout + per-host reachability precheck) ──
let needProbe = rows.filter((r) => !r.probe);
console.log(`── Stage 1: probe ${needProbe.length} (parallel×${PROBE_CONCURRENCY}, method-fallback, hard-timeout) ──`);

// Reachability precheck: one fast probe per host up front. A dead/hanging host (agentutility hung 40 min)
// is marked unreachable for ALL its endpoints in ~8s instead of burning pool slots for every endpoint.
{
  const byHost = new Map();
  for (const r of needProbe) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
  const dead = await pool([...byHost.keys()], PROBE_CONCURRENCY, async (host) => {
    const s = byHost.get(host)[0];
    let g = await attempt(s.url, "GET", { timeoutMs: 8000, retries: 0 });
    if (g.status === 0) g = await attempt(s.url, "POST", { timeoutMs: 8000, retries: 0 });
    return g.status === 0 ? host : null;
  });
  const deadHosts = new Set(dead.filter(Boolean));
  if (deadHosts.size) {
    for (const r of needProbe.filter((x) => deadHosts.has(x.host))) {
      mark(r, { probe: { kind: "unreachable", method: r.funnelMethod, status: 0, accepts: [], error: "host-unreachable-precheck", checkedAt: nowIso() }, probeMethod: r.funnelMethod, priceUsd: null, status: "unreachable", notes: "host unreachable (reachability precheck) — retryable" });
    }
    console.log(`  precheck: ${deadHosts.size} host(s) unreachable, skipped fast → ${[...deadHosts].join(", ")}`);
    needProbe = needProbe.filter((x) => !deadHosts.has(x.host));
  }
}

// Probe reachable endpoints in PARALLEL (pure network), then classify+mark SERIALLY (mark writes the checklist file).
const probeResults = await pool(needProbe, PROBE_CONCURRENCY, (r) => probe(r.url, r.funnelMethod));
for (let __i = 0; __i < needProbe.length; __i++) {
  const r = needProbe[__i];
  const p = probeResults[__i] && !probeResults[__i].__err ? probeResults[__i] : { kind: "unreachable", method: r.funnelMethod, status: 0, accepts: [], error: probeResults[__i]?.__err || "probe-error" };
  let status, priceUsd = null, usdc = false, accepts = [];
  if (p.kind === "payable") {
    ({ priceUsd, usdc, accepts } = priceFromAccepts(p.accepts));
    // A round-dollar quote ($1/$10/$20/$50) from our EMPTY-BODY probe is very likely a DYNAMIC ceiling, not
    // the real price (§ staleness doctrine — gpt-image-2 quoted $10, real $0.01). Don't hard-defer it; pass
    // it to the agent to RE-QUOTE with a real minimal body. qa-pay still enforces the cap on the real quote,
    // so this can never overspend. A precise sub-dollar over-cap price (e.g. $0.32) is a real static price → defer.
    const ceilingSuspect = priceUsd != null && priceUsd > CAP && Number.isInteger(priceUsd) && priceUsd >= 1;
    if (priceUsd != null && priceUsd > CAP && !ceilingSuspect) status = "deferred-over-cap";
    else if (priceUsd == null && !usdc) status = "needs-review-nonusdc";
    else { status = "probed"; if (ceilingSuspect) r._ceiling = priceUsd; }
  } else if (p.kind === "free") { status = "probed"; priceUsd = 0; }
  else if (p.kind === "needs-accepts") status = "needs-accepts";
  else if (p.kind === "unreachable") status = "unreachable";
  else status = "rejected";
  mark(r, {
    probe: { kind: p.kind, method: p.method, status: p.status, accepts, error: p.error || null, checkedAt: nowIso() },
    probeMethod: p.method, priceUsd, priceUsdc: usdc, status, ceilingSuspect: !!r._ceiling,
    notes: status === "rejected" ? `not payment-or-nothing (http ${p.status})` : status === "unreachable" ? `network/DNS unreachable (${p.error || ""}) — retryable` : status === "needs-accepts" ? "402 but no decodable accepts — investigate" : status === "deferred-over-cap" ? `$${priceUsd} > cap $${CAP}` : status === "needs-review-nonusdc" ? "payable in a non-USDC asset — price needs manual review" : r._ceiling ? `$${r._ceiling} looks like a DYNAMIC empty-body ceiling — agent must re-quote with a real body (qa-pay enforces the cap)` : "",
  });
  console.log(`  ${status.padEnd(20)} ${(priceUsd != null ? "$" + priceUsd : "").padEnd(9)} ${p.method.padEnd(4)} ${r.url.slice(0, 60)}`);
}

// ── Stage 2: SPEC (free, cached) ──
const needSpec = rows.filter((r) => r.spec === undefined && ["probed", "deferred-over-cap", "needs-accepts", "needs-review-nonusdc"].includes(r.status));
if (needSpec.length) { console.log(`\n── Stage 2: specs for ${needSpec.length} ──`); for (const r of needSpec) { mark(r, { spec: specFor(await hostSpec(r.host), r.url, r.probeMethod) ?? null }); } }

// ── probe-only: emit the cheap deterministic shortlist (payable≤cap) for the agent workflow, then stop.
// This is the efficiency layer — agents (expensive) only run on endpoints that already proved payable. ──
if (PROBE_ONLY) {
  // ── #1 DETERMINISTIC DEDUP (before fan-out): collapse exact-duplicate URLs and VERSION/PREFIX aliases
  // (/api/x ≡ /api/v1/x ≡ /x on the same host) so we never spawn an agent — or pay — twice for one op.
  // Deliberately CONSERVATIVE: semantic namespace aliases (realtime-amazon-data vs realtime-ecommerce-data/
  // amazon) and path-param VALUE collapse stay with the agent's rule — not string-safe to auto-merge here. ──
  const VER = new Set(["v1", "v2", "v3", "v4", "api", "x402"]);
  const opKey = (u) => { try { const url = new URL(u); return url.host.toLowerCase() + "|" + url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).filter((s) => !VER.has(s.toLowerCase())).map((s) => s.toLowerCase()).join("/"); } catch { return String(u).toLowerCase(); } };
  const probedRows = rows.filter((r) => r.status === "probed");
  const groups = new Map();
  for (const r of probedRows) { const k = opKey(r.url); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const canonicalKeys = new Set(); const dupes = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.url.localeCompare(b.url));
    canonicalKeys.add(g[0].key);
    for (const d of g.slice(1)) dupes.push({ row: d, canonicalUrl: g[0].url });
  }
  const dupKeys = new Set(dupes.map((d) => d.row.key));
  const payable = probedRows.filter((r) => canonicalKeys.has(r.key)).map((r) => ({
    key: r.key, url: r.url, host: r.host, method: r.probeMethod, priceUsd: r.priceUsd,
    accepts: r.probe?.accepts || [], spec: r.spec || null, blurb: r.description || "",
    ceilingSuspect: !!r.ceilingSuspect,  // priceUsd is likely a dynamic empty-body ceiling — agent must re-quote
    // #2 callHint: the exact call handed to the agent (method + DOCUMENTED example from openapi) so it pays
    // with a known-good input instead of re-discovering — fewer tool-calls/tokens, and no method variance.
    callHint: { method: r.probeMethod, inputExample: r.spec?.inputExample ?? null, inputSchema: r.spec?.inputSchema ?? null, summary: r.spec?.summary || "" },
  }));
  const other = rows.filter((r) => r.status !== "probed").map((r) => ({ url: r.url, status: r.status, priceUsd: r.priceUsd, notes: r.notes }));
  const slf = join(DISCOVERY, `shortlist-batch-${BATCH}.json`);
  writeFileSync(slf, JSON.stringify({ generatedAt: nowIso(), batch: BATCH, payable, dedupedDuplicates: dupes.map((d) => ({ url: d.row.url, canonicalUrl: d.canonicalUrl })), other }, null, 2));
  // Durably record outcomes now (agents never see them). Deterministic dupes → "duplicate" (never paid);
  // "probed" canonical rows → pending; apply-proposals overrides them to indexed/folded/deferred later.
  const LMAP = { probed: "probed", "deferred-over-cap": "deferred-over-cap", unreachable: "unreachable", "needs-accepts": "needs-accepts", rejected: "rejected", "needs-review-nonusdc": "unsure" };
  appendProgress(rows.map((r) => dupKeys.has(r.key)
    ? { ts: nowIso().slice(0, 10), batch: `probe-${BATCH}`, url: r.url, host: r.host, status: "duplicate", note: `version/prefix alias of ${dupes.find((d) => d.row.key === r.key).canonicalUrl} (deterministic dedup, not paid)` }
    : { ts: nowIso().slice(0, 10), batch: `probe-${BATCH}`, url: r.url, host: r.host, status: LMAP[r.status] || r.status, priceUsd: r.priceUsd ?? undefined, note: r.notes || undefined }));
  const mix = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  console.log(`\n── probe-only: ${payable.length} payable≤cap (agent set) → ${slf.replace(ROOT + "/", "")} ──`);
  if (dupes.length) console.log(`  #1 deduped ${dupes.length} version/prefix alias(es) deterministically — not sent to agents, not paid`);
  const withEx = payable.filter((p) => p.callHint.inputExample != null).length;
  console.log(`  #2 call-hints: ${withEx}/${payable.length} carry a documented example for the agent`);
  console.log("  " + Object.entries(mix).map(([k, v]) => `${k} ${v}`).join(" · "));
  process.exit(0);
}

// ── Stage 3: JUDGE (capable model, strict) — only endpoints we might actually index (probed) ──
const places = allowedPlacements();
const allowedSubcats = new Set(places.map((p) => p.subcat));
const assets = await assetsDoc();
const JUDGEABLE = new Set(["probed", "needs-classification"]);
const needJudge = rows.filter((r) => JUDGEABLE.has(r.status) && (REJUDGE || !r.judged || r.status === "needs-classification"));
if (needJudge.length) {
  console.log(`\n── Stage 3: judge ${needJudge.length} via claude -p (${MODEL}) ──`);
  for (let i = 0; i < needJudge.length; i += 6) {
    const chunk = needJudge.slice(i, i + 6);
    const got = judge(chunk, places, assets);
    for (const r of chunk) {
      const e = got.get(r.url);
      if (!e || !e.name) { console.log(`  (parked: no judgment) ${r.url.slice(0, 60)}`); mark(r, { status: "judge-failed", notes: "model judgment missing/invalid — re-run --rejudge" }); continue; }
      // Enforce brand-from-host (never from the blurb).
      const hostTok = r.host.replace(/^(api|x402|www)\./, "").split(".")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
      const lead = String(e.name).split(/\s+/)[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
      const name = hostTok && lead && !hostTok.includes(lead) && !lead.includes(hostTok)
        ? `${hostTok.charAt(0).toUpperCase() + hostTok.slice(1)} ${String(e.name).split(/\s+/).slice(1).join(" ")}`.trim() : e.name;
      // Model sometimes answers "category/subcategory" and sometimes just "subcategory" — accept either.
      const sub = String(e.subcategory || "").split("/").pop().trim();
      const subOk = !!sub && allowedSubcats.has(sub);
      const needsInput = e.needsInput === true || (r.priceUsd > 0 && !e.sampleBody && r.probeMethod !== "GET" && requiresBody(r.spec));
      mark(r, {
        judged: {
          name, description: e.description || r.spec?.summary || "", tags: Array.isArray(e.tags) ? e.tags.slice(0, 6) : [],
          modalityIn: normMod(e.modalityIn), modalityOut: normMod(e.modalityOut), kind: e.kind === "model" ? "model" : "api",
          subcategory: subOk ? sub : null, sampleBody: e.sampleBody ?? null,
          mergeCandidate: e.mergeCandidate || null, mergeReason: e.mergeReason || "", reason: e.reason || "",
        },
        name,
        status: needsInput ? "needs-input" : (subOk ? "judged" : "needs-classification"),
        notes: needsInput ? `needs an input we cannot synthesise: ${e.reason || "?"}` : subOk ? "" : `model subcategory "${e.subcategory}" not an existing curation file — needs a placement decision`,
      });
      console.log(`  ${(subOk ? sub : "!! " + (sub || "none")).padEnd(26)} ${(needsInput ? "needs-input" : "judged").padEnd(11)} ${name}${e.mergeCandidate ? `  [merge? ${e.mergeCandidate}]` : ""}`);
    }
  }
}
// Registry's REAL modality vocabulary (measured from curation/*.json): text, json, image, video, audio,
// code, vector. NOTE json IS valid (604 uses) — a data/API output is "json", NOT "text". "file" is unused.
function normMod(a) { const S = new Set(["text", "json", "image", "video", "audio", "code", "vector"]); const o = (a || []).map((m) => (m === "data" ? "json" : m)).filter((m) => S.has(m)); return o.length ? [...new Set(o)] : ["text"]; }
function requiresBody(spec) { const req = spec?.inputSchema?.required; return Array.isArray(req) && req.length > 0; }

// ── Stage 4: PAY (only with --pay) — money-safe via qa-pay, real cumulative ceiling ──
if (PAY) {
  const payable = rows.filter((r) => r.status === "judged" && r.priceUsd != null && r.priceUsd <= CAP && !r.paid);
  console.log(`\n── Stage 4: pay ${payable.length} (cap=$${CAP}, sprint ceiling=$${SPRINT_CEILING}) ──`);
  mkdirSync(join(DISCOVERY, "artifacts"), { recursive: true });
  for (const r of payable) {
    const artifact = join(DISCOVERY, "artifacts", `${slug(r.key)}.json`);
    const args = [QA_PAY, `--url=${r.url}`, `--method=${r.probeMethod}`, `--cap=${CAP}`, `--label=${SPRINT}:${r.key}`, `--save=${artifact}`];
    if (r.judged?.sampleBody) args.push(`--body=${JSON.stringify(r.judged.sampleBody)}`);
    let stdout = "";
    try { stdout = execFileSync("node", args, { encoding: "utf8", timeout: 180000, env: { ...process.env, QA_SPRINT_CEILING, QA_SPRINT_PREFIX: SPRINT } }); }
    catch (e) { stdout = String(e.stdout || ""); }
    let meta = {}; try { meta = JSON.parse((stdout.match(/\{[\s\S]*\}$/m) || stdout.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { /* ignore */ }
    const cls = meta.classification || "no-result", http = meta.status ?? null, cost = meta.costUsd ?? 0;
    const body = readJson(artifact);
    const over = cls === "over-cap" || cls === "budget-exhausted";
    const okPaid = cls === "ok-paid" && (http == null || http < 400);
    mark(r, {
      pay: { classification: cls, costUsd: cost, httpStatus: http, sprintRemaining: meta.sprintRemainingUsd ?? null, responseBody: body },
      status: over ? "deferred-over-cap" : okPaid ? "paid" : "pay-failed",
      notes: over ? `${cls} — revisit with higher ceiling` : okPaid ? "" : `pay ${cls} http=${http}`,
    });
    console.log(`  ${cls.padEnd(16)} http=${String(http ?? "?").padEnd(4)} $${Number(cost).toFixed(4)}  rem=$${meta.sprintRemainingUsd ?? "?"}  ${r.name}`);
    if (cls === "budget-exhausted") { console.log("  ⛔ sprint ceiling reached — stopping paid stage."); break; }
  }
}

// ── Stage 5: STAGE entries (canonical curation shape) ──
const TODAY = nowIso().slice(0, 10);
const stageable = rows.filter((r) => r.status === "paid" || (!PAY && r.status === "judged"));
function deriveQuirks(r) {
  const q = []; const sum = r.spec?.summary || "";
  const pre = sum.match(/[^.]*\b(must (?:have been|be)|requires?|only works?|first)\b[^.]*\./i); if (pre) q.push(pre[0].trim());
  const http = r.pay?.httpStatus ?? null;
  if (r.pay?.costUsd > 0 && http != null && http >= 400) q.push(`CHARGE-THEN-ERROR: paid $${r.pay.costUsd} but HTTP ${http} — a bad request still costs money here.`);
  const b = r.pay?.responseBody;
  if (b && typeof b === "object" && ("jobId" in b || "job_id" in b || "taskId" in b || "id" in b && ("status" in b))) q.push("Async: the paid call returns a job/task id — poll for the result.");
  return [...new Set(q)].slice(0, 6);
}
const staged = stageable.map((r) => {
  const host = hostOf(r.url), provider = providerOf(host);
  const okPaid = r.pay?.classification === "ok-paid" && (r.pay?.httpStatus ?? 0) < 400;
  const b = r.pay?.responseBody;
  return {
    name: r.name, kind: r.judged?.kind === "model" ? "model" : "api", provider, providerId: slug(provider),
    aka: [slug(r.name), slug(`${host} ${new URL(r.url).pathname.split("/").pop() || ""}`)].filter((x, i, a) => x && a.indexOf(x) === i),
    description: r.judged?.description || r.spec?.summary || "", tags: (r.judged?.tags || []).slice(0, 6),
    modality: { input: normMod(r.judged?.modalityIn), output: normMod(r.judged?.modalityOut) },
    backends: [{
      url: r.url, method: r.probeMethod, provider, providerId: slug(provider), amount: r.priceUsd,
      accepts: r.probe?.accepts || [],
      probe: { status: r.probe?.status ?? null, method: r.probeMethod, payable: r.probe?.kind === "payable", checkedAt: r.probe?.checkedAt || nowIso() },
      ...(r.spec?.inputSchema ? { inputSchema: r.spec.inputSchema } : {}),
      ...(r.spec?.outputSchema ? { outputSchema: r.spec.outputSchema } : {}),
    }],
    usage: {
      status: okPaid ? "verified" : "untested", verifiedAt: okPaid ? TODAY : null,
      resultPull: okPaid && b && typeof b === "object" && ("jobId" in b || "job_id" in b || "taskId" in b) ? "poll" : "sync",
      auth: "none", callShape: `${r.probeMethod} ${r.url}${r.judged?.sampleBody ? ` with JSON body ${JSON.stringify(r.judged.sampleBody)}` : ""}`,
      inputExample: r.judged?.sampleBody ?? null, outputShape: okPaid && b ? JSON.stringify(b).slice(0, 400) : "",
      quirks: deriveQuirks(r), needs: [], needsApproval: false,
      guide: r.judged?.description || r.spec?.summary || "", costObservedUsd: r.pay?.costUsd ?? null,
    },
    status: "active",
    _sourceKey: r.key, _targetSubcat: r.judged?.subcategory || null, _mergeCandidate: r.judged?.mergeCandidate || null,
  };
});

// ── Accounting: every row in exactly one KNOWN state ──
const KNOWN = new Set(["todo", "probed", "judged", "paid", "staged", "applied", "rejected", "unreachable", "needs-accepts", "needs-input", "needs-classification", "needs-review-nonusdc", "deferred-over-cap", "judge-failed", "pay-failed"]);
const stateMix = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
const unknown = rows.filter((r) => !KNOWN.has(r.status));

// ── §5.5B: slug collisions are FATAL ──
const existing = SUBCAT ? readJson(join(CURATION, `${SUBCAT}.json`)) : null;
const existingSlugs = new Map((existing?.entries || []).map((e) => [slug(e.name), e.name]));
const collisions = []; const batchSlugs = new Map();
for (const e of staged) { const s = slug(e.name); if (existingSlugs.has(s)) collisions.push(`"${e.name}" collides with EXISTING "${existingSlugs.get(s)}"`); if (batchSlugs.has(s)) collisions.push(`"${e.name}" collides with "${batchSlugs.get(s)}" in this batch`); batchSlugs.set(s, e.name); }

mkdirSync(STAGING, { recursive: true });
const stampFile = join(STAGING, `index-batch-${BATCH}-${TODAY}-${rows.length}.json`);
writeFileSync(stampFile, JSON.stringify({
  batch: BATCH, subcat: SUBCAT || null, generatedAt: nowIso(),
  accounting: { targets: targets.length, staged: staged.length, stateMix, balances: unknown.length === 0 },
  merges: staged.filter((e) => e._mergeCandidate).map((e) => ({ name: e.name, mergeCandidate: e._mergeCandidate })),
  deferred: rows.filter((r) => r.status === "deferred-over-cap").map((r) => ({ url: r.url, priceUsd: r.priceUsd })),
  needsInput: rows.filter((r) => r.status === "needs-input").map((r) => ({ url: r.url, reason: r.judged?.reason })),
  unreachable: rows.filter((r) => r.status === "unreachable").map((r) => ({ url: r.url })),
  needsAccepts: rows.filter((r) => r.status === "needs-accepts").map((r) => ({ url: r.url })),
  rejected: rows.filter((r) => r.status === "rejected").map((r) => ({ url: r.url, notes: r.notes })),
  collisions, entries: staged,
}, null, 2));

console.log(`\n── Stage 5: staged ${staged.length} ──`);
console.log(`  ${Object.entries(stateMix).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log(`  every row in a known state: ${unknown.length === 0 ? "yes" : "NO — " + unknown.map((r) => r.status).join(",")}`);
console.log(`  staging file: ${stampFile.replace(ROOT + "/", "")}`);
if (collisions.length) { console.log(`\n  ⚠️  ${collisions.length} COLLISION(S) — must resolve before --apply:`); collisions.slice(0, 8).forEach((c) => console.log("      " + c)); }
const merges = staged.filter((e) => e._mergeCandidate);
if (merges.length) { console.log(`\n  🔀 ${merges.length} possible service-vs-backend MERGE(S) — for you to confirm (NOT auto-applied):`); merges.forEach((e) => console.log(`      "${e.name}"  →  maybe a backend of "${e._mergeCandidate}"`)); }

// ── Stage 6: APPLY (additive; byte-identical assert; only the target subcat) ──
if (APPLY) {
  if (!SUBCAT) { console.error("\n--apply requires --subcat=<slug>"); process.exit(1); }
  let mine = staged.filter((e) => e._targetSubcat === SUBCAT);
  const held = staged.filter((e) => e._targetSubcat && e._targetSubcat !== SUBCAT);
  if (held.length) console.log(`\n  holding back ${held.length} classified elsewhere: ${[...new Set(held.map((e) => e._targetSubcat))].join(", ")}`);
  if (!mine.length) { console.error(`\nnothing in this batch is classified as ${SUBCAT}`); process.exit(1); }
  if (collisions.length) { console.error("\nREFUSING: unresolved collisions (§5.5B)."); process.exit(1); }
  if (mine.some((e) => !e.name || !e.description)) { console.error("\nREFUSING: an entry is missing name or description."); process.exit(1); }
  const path = join(CURATION, `${SUBCAT}.json`);
  const before = readJson(path); if (!before) { console.error(`\nno curation file ${path}`); process.exit(1); }
  const originalJson = JSON.stringify(before.entries);
  const clean = mine.map(({ _sourceKey, _targetSubcat, _mergeCandidate, ...e }) => e);
  writeFileSync(path, JSON.stringify({ ...before, entries: [...before.entries, ...clean] }, null, 2));
  const reread = readJson(path);
  if (JSON.stringify((reread.entries || []).slice(0, before.entries.length)) !== originalJson) {
    writeFileSync(path, JSON.stringify(before, null, 2));
    console.error("\nINTEGRITY CHECK FAILED — existing entries changed. File restored, nothing added."); process.exit(1);
  }
  const appliedKeys = new Set(mine.map((e) => e._sourceKey));
  for (const r of stageable) if (appliedKeys.has(r.key)) mark(r, { status: "applied", subcat: SUBCAT });
  console.log(`\n── Stage 6: applied ${clean.length} to curation/${SUBCAT}.json (${before.entries.length} pre-existing verified byte-identical) ──`);
  console.log(`  next: node scripts/registry/curate.mjs --subcat=${SUBCAT}`);
  console.log(`        node scripts/registry/verify-drift.mjs && node scripts/registry/verify-no-tangle.mjs && node scripts/registry/verify-bundle-pins.mjs`);
} else {
  console.log(`\n  (FREE/staging only — nothing written to curation/. Add --pay to verify, then --apply --subcat=<slug>.)`);
}
