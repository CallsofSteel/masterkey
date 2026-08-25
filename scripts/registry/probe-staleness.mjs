#!/usr/bin/env node
/**
 * probe-staleness.mjs — READ-ONLY staleness check for indexed x402 endpoints.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 🛑 HOW TO TREAT THIS OUTPUT — READ BEFORE YOU CHANGE ANY REGISTRY DATA
 *
 * This tool is a SCREENING tool, not an oracle. Its output is a shortlist of LEADS, not findings.
 * DO NOT go straight from a report to editing curation/. That path hides working services.
 *
 * It is ASYMMETRIC:
 *   • "alive-*" — TRUST IT. A response is direct proof the route exists; a false positive here is
 *     essentially impossible.
 *   • "DEAD" / "host-down" / price "drift" — DO NOT TRUST ON ITS OWN. Absence of a good response has
 *     many innocent causes (our own concurrency, a blip, an unsubstituted {placeholder}, throttling).
 *
 * Before hiding or re-pricing ANYTHING, do both:
 *   1. RE-VERIFY SERIALLY (concurrency 1, one endpoint at a time). This alone recovered 23 endpoints
 *      on the 2026-07-26 sweep.
 *   2. CORROBORATE WITH A SECOND SOURCE — the provider's OpenAPI, its llms.txt, or its own error body.
 *      StableTravel's 25 dead routes were confirmed three ways before being hidden. That is the bar.
 *
 * Two heuristics that caught real bugs, worth applying to any future run:
 *   • ONE CONTRADICTION INVALIDATES THE RUN. blockrun.ai reported 8 "host-down" beside 109 alive
 *     endpoints — that means the PROBE is broken, not the host.
 *   • A SUSPICIOUSLY ROUND NUMBER IS A CEILING, NOT A PRICE. $10 / $1 / $20 recurring across one host
 *     is a worst-case quote for our synthetic body, not that endpoint's real price.
 *
 * Near-misses this guidance exists to prevent (both real, both caught only by double-checking):
 *   • `crypto-price` was reported DEAD one hour after we had successfully called it — a literal
 *     "/price/{sym}" 404s.
 *   • `gpt-image-2` was reported as drifting $0.01 -> $10. Re-quoting with the registry's own
 *     usage.inputExample returned exactly $0.01: the registry was right. Applying blind would have put
 *     $10 on a 1-cent image and broken the budget gate. 25 of 118 "drifts" evaporated this way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ WRITES NOTHING. It never touches curation/, by-subcat/, or index.json. Output is a report on
 * stdout plus an optional JSON file OUTSIDE the registry (--out). Applying findings is a separate,
 * deliberate step (edit curation/ -> curate.mjs -> verify-drift + verify-no-tangle).
 *
 * SPENDS NOTHING. Probes are unpaid: no X-PAYMENT header is ever sent, so a paid endpoint answers 402
 * (its price quote) without settling. Two guards keep that true:
 *   • A mutating verb (POST/PUT/PATCH/DELETE) is only probed when the registry says the endpoint COSTS
 *     money — the 402 gate then rejects it before any side effect. A FREE mutating endpoint is SKIPPED,
 *     because an unpaid POST there would really run (really send the email, really place the order).
 *   • Anything flagged needsApproval is skipped for mutating verbs regardless of price.
 *
 * Verdicts:
 *   alive-paid  402  route live; the quote also gives us the CURRENT price -> drift detection
 *   alive-free  2xx  route live and free
 *   alive-gated 401/403  route live but auth/ownership-gated ahead of payment
 *   alive-other 3xx/400/422/429  route EXISTS — it parsed and rejected our synthetic empty body, or
 *               redirected, or rate-limited us. A 400 is positive evidence of liveness, not staleness.
 *   DEAD        404/410  route gone  (only high-confidence when the path has no {placeholders})
 *   host-down   the ORIGIN itself is unreachable (its root fails too) — whole provider gone/parked
 *   inconclusive 5xx / timeout / transient network error — provider trouble, NOT evidence of removal
 *
 * Network errors are retried (they are NOT trusted first time): a concurrent sweep provokes connection
 * resets that look identical to a dead host. On the final failure we probe the ORIGIN ROOT to tell
 * "this host is gone" (host-down) from "this one path is flaky" (inconclusive).
 *
 * Usage:
 *   node scripts/registry/probe-staleness.mjs --host=stabletravel.dev,stableenrich.dev [--out=/tmp/r.json]
 *   node scripts/registry/probe-staleness.mjs --host=stable            # substring match
 */
import fs from "node:fs";
import path from "node:path";

const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const hostFilters = arg("host").split(",").map((s) => s.trim()).filter(Boolean);
const outPath = arg("out");
const CONCURRENCY = Number(arg("concurrency", "6"));
const TIMEOUT_MS = 20_000;
if (!hostFilters.length) {
  console.error("refusing to probe everything — pass --host=<substring>[,<substring>]");
  process.exit(1);
}

const DIR = path.join(process.cwd(), "data/registry/by-subcat");
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Collect every served target on the requested hosts. */
const targets = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const svc of Array.isArray(raw) ? raw : raw.services || []) {
    if (svc.status === "hidden") continue;
    const items = [
      ...(svc.backends || [])
        .filter((b) => b.status !== "hidden" && b.status !== "dead")
        .map((b) => ({ kind: "backend", name: b.provider, url: b.url, method: b.method, price: b.price, needsApproval: svc.needsApproval })),
      ...(svc.operations || []).map((o) => ({ kind: "operation", name: o.name, url: o.url, method: o.method, price: o.price, needsApproval: o.needsApproval })),
    ];
    for (const it of items) {
      if (!it.url) continue;
      let host;
      try { host = new URL(it.url).host; } catch { continue; }
      if (!hostFilters.some((h) => host.includes(h))) continue;
      targets.push({ ...it, host, subcat: f.replace(/\.json$/, ""), serviceId: svc.id, serviceName: svc.name });
    }
  }
}

/**
 * Known USDC contracts -> 6 decimals. We ONLY convert an amount to USD when we recognise the asset.
 * Assuming 6 decimals for everything produced a "$10,000,000,000" quote for coinmarketcap and would
 * have had us "correcting" the registry to a garbage number. Unknown asset => liveUsd null => no drift
 * claim, because a comparison we cannot trust is worse than no comparison.
 */
const USDC = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // Polygon
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // Avalanche
  "0x74b7f16337b8972027f6196a17a631ac6de26d22", // X Layer
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",  // Solana
]);
const usdFromAccept = (a) => {
  if (!a || a.amount == null) return null;
  const asset = String(a.asset || "").toLowerCase();
  if (!USDC.has(asset)) return null; // unknown asset/decimals — refuse to guess
  return Number(a.amount) / 1e6;
};

const decodeAccepts = (headerVal, body) => {
  for (const src of [headerVal, body]) {
    if (!src) continue;
    try {
      const j = typeof src === "string" && !src.trim().startsWith("{")
        ? JSON.parse(Buffer.from(src, "base64").toString("utf8"))
        : (typeof src === "string" ? JSON.parse(src) : src);
      const a = j?.accepts || j?.paymentRequirements;
      if (Array.isArray(a) && a.length) return a;
    } catch { /* next */ }
  }
  return null;
};

/** Gateways whose 402 amount depends on the request BODY, so an empty-body quote is not comparable. */
const BODY_PRICED = ["x402.monid.ai"];

async function probe(t) {
  const method = (t.method || "GET").toUpperCase();
  const storedUsd = typeof t.price?.amount === "number" ? t.price.amount : null;
  const templated = /\{[^}]+\}|:[a-zA-Z]\w*(?=\/|$)/.test(new URL(t.url).pathname);

  // --- safety gates (see header) ---
  if (MUTATING.has(method) && !(storedUsd > 0)) {
    return { ...t, verdict: "skipped", detail: "free + mutating — an unpaid call could really execute" };
  }
  if (MUTATING.has(method) && t.needsApproval) {
    return { ...t, verdict: "skipped", detail: "needsApproval + mutating — not probed" };
  }

  const once = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(t.url, {
        method,
        headers: { "User-Agent": "Mozilla/5.0", ...(MUTATING.has(method) ? { "Content-Type": "application/json" } : {}) },
        ...(MUTATING.has(method) ? { body: "{}" } : {}),
        redirect: "manual",
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { res, text } = await once();
      const s = res.status;

      if (s === 402) {
        const accepts = decodeAccepts(res.headers.get("payment-required"), text);
        const liveUsd = usdFromAccept(accepts?.[0]);
        // Never claim drift for a body-priced gateway: our synthetic empty body gets the BASE quote,
        // not the price of the call the registry describes (monid prices by {provider,endpoint}).
        const bodyPriced = BODY_PRICED.some((h) => t.host.includes(h));
        const drift = !bodyPriced && liveUsd != null && storedUsd != null && Math.abs(liveUsd - storedUsd) > 1e-9;
        return { ...t, verdict: "alive-paid", status: s, storedUsd, liveUsd, drift, ...(bodyPriced ? { detail: "body-priced gateway — quote not comparable to the stored per-call price" } : {}) };
      }
      if (s >= 200 && s < 300) return { ...t, verdict: "alive-free", status: s, storedUsd, liveUsd: 0, drift: storedUsd != null && storedUsd > 0 };
      if (s === 401 || s === 403) return { ...t, verdict: "alive-gated", status: s, storedUsd };
      if (s === 404 || s === 410) {
        // A 404 on a TEMPLATED url proves nothing — we sent a literal "{id}". Report it as unverifiable
        // rather than DEAD, so nobody hides a working service over a placeholder. (This exact bug flagged
        // crypto-price as dead while it was serving real prices.)
        if (templated) return { ...t, verdict: "unverifiable-template", status: s, storedUsd, detail: "404 on an unsubstituted {placeholder} — needs a real sample value to judge" };
        return { ...t, verdict: "DEAD", status: s, storedUsd };
      }
      // 3xx / 400 / 422 / 429 -> the route exists; it redirected, rejected our synthetic body, or throttled.
      if ((s >= 300 && s < 400) || s === 400 || s === 422 || s === 429) {
        return { ...t, verdict: "alive-other", status: s, storedUsd, detail: s === 400 || s === 422 ? "route parsed and rejected the empty probe body — it exists" : undefined };
      }
      return { ...t, verdict: "inconclusive", status: s, storedUsd }; // 5xx
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))); // transient? back off
    }
  }

  // Three network failures. Distinguish "the whole origin is gone" from "this path is flaky".
  const detail = lastErr?.name === "AbortError" ? "timeout" : String(lastErr?.message || lastErr);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const root = await fetch(new URL(t.url).origin, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    return { ...t, verdict: "inconclusive", status: 0, storedUsd, detail: `${detail} (origin root reachable: ${root.status})` };
  } catch {
    return { ...t, verdict: "host-down", status: 0, storedUsd, detail: `${detail} — origin root unreachable too` };
  }
}

// --- run with a small concurrency cap (be polite to providers) ---
const results = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      results.push(await probe(t));
      process.stderr.write(`\r  probed ${results.length}/${targets.length}   `);
    }
  }),
);
process.stderr.write("\n");

// --- report ---
const by = (v) => results.filter((r) => r.verdict === v);
const dead = by("DEAD");
const hostDown = by("host-down");
const drifted = results.filter((r) => r.drift);
const inconclusive = by("inconclusive");
const skipped = by("skipped");

const fmt = (r) => `${(r.method || "GET").padEnd(6)} ${r.url}`;
console.log(`\n=== staleness report — ${hostFilters.join(", ")} ===`);
console.log(`targets: ${targets.length}  |  alive-paid ${by("alive-paid").length}  alive-free ${by("alive-free").length}  alive-gated ${by("alive-gated").length}  alive-other ${by("alive-other").length}  DEAD ${dead.length}  host-down ${hostDown.length}  inconclusive ${inconclusive.length}  skipped ${skipped.length}`);
if (hostDown.length) {
  const hosts = [...new Set(hostDown.map((r) => r.host))];
  console.log(`
--- HOST DOWN (${hostDown.length} endpoints across ${hosts.length} origins) — the origin itself is unreachable ---`);
  for (const h of hosts) console.log(`  ${h.padEnd(46)} ${hostDown.filter((r) => r.host === h).length} endpoint(s)`);
}

if (dead.length) {
  console.log(`\n--- DEAD (${dead.length}) — 404/410, route removed upstream ---`);
  for (const r of dead) console.log(`  [${r.status}] ${r.serviceId.padEnd(38)} ${fmt(r)}`);
}
if (drifted.length) {
  console.log(`\n--- PRICE DRIFT (${drifted.length}) — registry disagrees with the live quote ---`);
  for (const r of drifted) console.log(`  ${r.serviceId.padEnd(38)} stored $${r.storedUsd}  ->  live $${r.liveUsd}   ${fmt(r)}`);
}
if (inconclusive.length) {
  console.log(`\n--- INCONCLUSIVE (${inconclusive.length}) — provider error/timeout, NOT proof of removal ---`);
  for (const r of inconclusive) console.log(`  [${r.status || "net"}] ${r.serviceId.padEnd(38)} ${r.detail || ""} ${fmt(r)}`);
}
if (skipped.length) {
  console.log(`\n--- SKIPPED for safety (${skipped.length}) ---`);
  for (const r of skipped) console.log(`  ${r.serviceId.padEnd(38)} ${r.detail}`);
}

// Per-service rollup: a service is only fully dead when EVERY one of its targets is dead.
const svcMap = new Map();
for (const r of results) {
  const e = svcMap.get(r.serviceId) || { name: r.serviceName, total: 0, dead: 0 };
  e.total++; if (r.verdict === "DEAD") e.dead++;
  svcMap.set(r.serviceId, e);
}
const fullyDead = [...svcMap].filter(([, e]) => e.total > 0 && e.dead === e.total);
if (fullyDead.length) {
  console.log(`\n--- SERVICES WITH NO SURVIVING ENDPOINT (${fullyDead.length}) — hide candidates ---`);
  for (const [id, e] of fullyDead) console.log(`  ${id.padEnd(38)} ${e.name}`);
}

console.log(`\nREAD-ONLY: nothing in data/registry or scripts/registry/curation was modified.`);
if (dead.length || hostDown.length || drifted.length) {
  console.log(
    `\n🛑 THESE ARE LEADS, NOT FINDINGS — do NOT edit curation/ straight from this report.\n` +
    `   "alive-*" is trustworthy; DEAD / host-down / drift are NOT trustworthy on their own.\n` +
    `   Before hiding or re-pricing anything:\n` +
    `     1. re-verify SERIALLY (concurrency 1) — this recovered 23 endpoints on the 2026-07-26 sweep;\n` +
    `     2. corroborate with a second source (provider OpenAPI / llms.txt / its own error body).\n` +
    `   A host showing BOTH "host-down" and "alive" endpoints means this probe is wrong, not the host.\n` +
    `   A recurring round number ($10/$1/$20) is a worst-case ceiling for our synthetic body, not a price —\n` +
    `   re-quote using the registry's own usage.inputExample before believing any drift.\n` +
    `   Full rationale + the near-misses this prevents: the header of this file, and the STALENESS\n` +
    `   bullet in MASTERKEY_HANDOFF.md.`,
  );
}
if (outPath) { fs.writeFileSync(outPath, JSON.stringify({ hostFilters, results }, null, 2)); console.log(`report written to ${outPath}`); }
