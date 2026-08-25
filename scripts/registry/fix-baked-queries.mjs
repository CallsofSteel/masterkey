// One-off remediation: strip baked example query strings from curation backend/operation URLs, and
// enrich inputSchema.properties so any param that was ONLY discoverable via the baked example stays
// discoverable. Born from the agentstools-congress-trades bug (a probe's example query — e.g.
// ?member=Aderholt&startdt=...&enddt=... — got frozen into the stored URL, so run.ts appended the real
// input as a DUPLICATE param and the example leaked / pinned a date window).
//
// SAFE BY DESIGN:
//  - Edits ONLY curation/*.json (the hand-editable source), never by-subcat/index (run curate after).
//  - Targeted: only touches url + inputSchema of backends/ops whose url has a concrete (non-{token})
//    query value. Everything else is byte-preserved by re-stringifying with the same JSON.stringify(x,null,2).
//  - Re-probes each affected endpoint (best-effort, UNPAID) to corroborate the param set from the live
//    402 bazaar.info.input, and to confirm the endpoint still challenges. Falls back to the baked keys.
//  - Flags "constant-like" params (format/output/version/key…) for manual review instead of guessing.
//
// Usage: node scripts/registry/fix-baked-queries.mjs [--apply] [--probe]
//   (default = dry-run, no writes, no network unless --probe)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CUR = join(ROOT, "scripts/registry/curation");
const APPLY = process.argv.includes("--apply");
const PROBE = process.argv.includes("--probe");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// A param we KEEP in the URL as a genuine fixed constant (not a user input). Only true format/output
// selectors — verified case: WolframAlpha needs ?output=json or it returns XML. token/key/version look
// constant-like but are real inputs (crypto token, hotspot key, scan version) → those get stripped+enriched.
const isKeptConstant = (k, v) => /^(output|format)$/i.test(k) && /^(json|xml|csv|text|html)$/i.test(v);
const isTemplate = (v) => typeof v === "string" && v.startsWith("{") && v.endsWith("}");

// Curation files were written with INCONSISTENT formatting (some escape non-ASCII to \uXXXX, some keep it
// literal; none have a trailing newline). To keep diffs surgical, detect a file's exact style from its
// original bytes and re-emit the mutated object in the SAME style — so an unmodified region stays byte-identical.
function escNonAscii(s) {
  let out = "";
  for (const ch of s) { const c = ch.codePointAt(0); out += c > 0x7f ? "\\u" + c.toString(16).padStart(4, "0") : ch; }
  return out;
}
function serializeLike(origText, obj) {
  const plain = JSON.stringify(obj, null, 2);
  const origPlain = JSON.stringify(JSON.parse(origText), null, 2);
  if (origText === origPlain) return plain;
  if (origText === origPlain + "\n") return plain + "\n";
  if (origText === escNonAscii(origPlain)) return escNonAscii(plain);
  if (origText === escNonAscii(origPlain) + "\n") return escNonAscii(plain) + "\n";
  return null; // unknown style — refuse to write (avoid a noisy whole-file reformat)
}
function splitUrl(u) {
  const i = u.indexOf("?");
  if (i === -1) return { base: u, pairs: [] };
  const base = u.slice(0, i);
  const pairs = u.slice(i + 1).split("&").filter(Boolean).map((kv) => {
    const eq = kv.indexOf("=");
    return eq === -1 ? [decodeURIComponent(kv), ""] : [decodeURIComponent(kv.slice(0, eq)), decodeURIComponent(kv.slice(eq + 1))];
  });
  return { base, pairs };
}
function inferType(v) {
  if (/^-?\d+$/.test(v)) return "integer";
  if (/^-?\d*\.\d+$/.test(v)) return "number";
  if (/^(true|false)$/i.test(v)) return "boolean";
  return "string";
}
// Find (or create) the properties container run's discovery layer + curators expect. Prefer an existing
// shape: top-level properties, or queryParams.properties, or body.properties. Returns {props, ensure()}.
function propsContainer(schema) {
  if (!schema || typeof schema !== "object") return null;
  // bazaar-nested shape (raw CDP-Bazaar schema stored verbatim): the real params live under
  // (body|top).properties.input.properties.(queryParams|body).properties — check this FIRST so we don't
  // mistake the wrapper ({input,output}) for the param container and add duplicates.
  const inputNode = schema.body?.properties?.input?.properties || schema.properties?.input?.properties;
  if (inputNode?.queryParams?.properties) return inputNode.queryParams.properties;
  if (inputNode?.body?.properties) return inputNode.body.properties;
  if (schema.queryParams?.properties) return schema.queryParams.properties;
  if (schema.properties && typeof schema.properties === "object" && !schema.properties.input) return schema.properties;
  if (schema.body?.properties && !schema.body.properties.input) return schema.body.properties;
  return null;
}

async function probeParams(method, base, sampleBody) {
  if (!PROBE) return null;
  try {
    const opt = { method, headers: { "User-Agent": UA }, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(sampleBody || {}); }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(base, { ...opt, signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (!r) return null;
    const hdr = r.headers.get("payment-required");
    if (!hdr) return { status: r.status, params: null };
    let d; try { d = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); } catch { return { status: r.status, params: null }; }
    const inp = d?.extensions?.bazaar?.info?.input || {};
    const params = inp.queryParams ? Object.keys(inp.queryParams) : (inp.body ? Object.keys(inp.body) : null);
    return { status: r.status, params };
  } catch { return null; }
}

const report = [];
const files = readdirSync(CUR).filter((f) => f.endsWith(".json"));

for (const f of files) {
  const path = join(CUR, f);
  let text;
  try { text = readFileSync(path, "utf8"); } catch { continue; }
  let data;
  try { data = JSON.parse(text); } catch { continue; }
  if (!data.entries) continue;
  let changed = false;

  for (const e of data.entries) {
    const targets = [];
    for (const b of e.backends || []) if (b && typeof b === "object") targets.push(b);
    for (const op of e.operations || []) if (op && typeof op === "object") targets.push(op);
    for (const t of targets) {
      const u = t.url;
      if (typeof u !== "string" || !u.includes("?")) continue;
      const { base, pairs } = splitUrl(u);
      const concrete = pairs.filter(([, v]) => v && !isTemplate(v));
      if (concrete.length === 0) continue; // pure-{token} templates work via run.ts substitution — leave alone
      const kept = pairs.filter(([k, v]) => isKeptConstant(k, v));            // genuine fixed constants → stay in URL
      const stripKeys = pairs.filter((p) => !kept.includes(p)).map(([k]) => k); // inputs (+ {tokens}) → move to schema
      const container = propsContainer(t.inputSchema);
      const known = container ? new Set(Object.keys(container)) : new Set();
      const missing = stripKeys.filter((k) => !known.has(k));

      // best-effort corroboration of the input param set from the live 402 bazaar.info.input
      let probe = null;
      if (missing.length) probe = await probeParams(t.method || "GET", base, undefined);

      const toAdd = new Set(missing);
      if (probe?.params) for (const p of probe.params) if (!known.has(p)) toAdd.add(p);
      if (toAdd.size) {
        if (!t.inputSchema || typeof t.inputSchema !== "object") t.inputSchema = { type: "object", properties: {}, required: [] };
        let props = propsContainer(t.inputSchema);
        if (!props) { t.inputSchema.type = t.inputSchema.type || "object"; t.inputSchema.properties = t.inputSchema.properties || {}; props = t.inputSchema.properties; }
        for (const k of toAdd) {
          const ex = concrete.find(([kk]) => kk === k)?.[1];
          props[k] = { type: ex != null ? inferType(ex) : "string", description: `Input/filter query param (name from the provider's own example; added during baked-query remediation so it stays discoverable).` };
        }
      }
      const newUrl = base + (kept.length ? "?" + kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "");
      t.url = newUrl;
      changed = true;
      report.push({ file: f, id: e.id || e.name, from: u, to: newUrl, stripped: stripKeys, kept: kept.map(([k, v]) => `${k}=${v}`), added: [...toAdd], probeStatus: probe?.status ?? null });
    }
  }
  if (changed && APPLY) {
    const out = serializeLike(text, data);
    if (out == null) { console.error(`⚠ SKIP ${f}: unknown formatting style — not writing to avoid a noisy reformat (handle manually)`); }
    else writeFileSync(path, out);
  }
}

// summary
const byFile = {};
for (const r of report) (byFile[r.file] ||= []).push(r);
console.log(`${APPLY ? "APPLIED" : "DRY-RUN"} — ${report.length} affected backends/ops across ${Object.keys(byFile).length} curation files`);
console.log(`enriched (added schema params): ${report.filter((r) => r.added.length).length} | strip-only: ${report.filter((r) => !r.added.length).length} | kept a constant param: ${report.filter((r) => r.kept.length).length}`);
console.log("");
for (const [f, rows] of Object.entries(byFile)) {
  console.log(`## ${f} (${rows.length})`);
  for (const r of rows) {
    console.log(`  ${r.id}`);
    console.log(`    ${r.from}`);
    console.log(`    -> ${r.to}   stripped=[${r.stripped.join(",")}] added=[${r.added.join(",")}]${r.kept.length ? " KEPT=[" + r.kept.join(",") + "]" : ""}${r.probeStatus ? " probe=" + r.probeStatus : ""}`);
  }
}
const kept = report.filter((r) => r.kept.length);
if (kept.length) {
  console.log("\nKEPT constant params in URL (not treated as inputs):");
  for (const r of kept) console.log(`  ${r.id}: ${r.kept.join(", ")}`);
}
const subcats = [...new Set(Object.keys(byFile).map((f) => f.replace(/\.json$/, "")))];
console.log(`\nTouched subcats (curate these): ${subcats.join(" ")}`);
