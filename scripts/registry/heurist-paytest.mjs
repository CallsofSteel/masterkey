/**
 * heurist-paytest.mjs — pay-test every Heurist Mesh x402 tool (mesh.heurist.xyz/x402/agents/{agent}/{tool}).
 * Pulls live agents + mesh_schema (real param schemas + per-tool price), builds schema-correct inputs,
 * pays via qa-pay (cap $3 + sprint backstop, idempotent). Tools that need a job-id from a prior call are
 * parked needs-input. Heurist's x402 challenge is in the BODY (accepts there), handled by payProvider.
 *
 * Usage: node scripts/registry/heurist-paytest.mjs [--only=DefiLlamaAgent,...] [--cap=3] [--dry]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/heurist");
mkdirSync(ART, { recursive: true });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const CAP = arg("cap", "3");
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const DRY = flag("dry");
const BASE = "https://mesh.heurist.xyz";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// fill a value for a schema property by name/type
function valueFor(name, prop) {
  const n = name.toLowerCase();
  const t = prop?.type;
  if (/job_?id|task_?id|request_?id|research_?id|run_?id/.test(n)) return undefined; // needs a prior submit
  if (/chain_?id/.test(n)) return t === "integer" || t === "number" ? 8453 : "8453";
  if (/chain|network/.test(n)) return "base";
  if (/contract|token_address/.test(n)) return WETH;   // before generic address (contract_address contains "address")
  if (/wallet|address|account|owner|holder/.test(n)) return VITALIK;
  if (/protocol/.test(n)) return "aave-v3";
  if (/symbol|ticker/.test(n)) return n.endsWith("s") ? ["AAPL"] : "AAPL";
  if (/coin|coingecko|token_id|token\b/.test(n)) return "bitcoin";
  if (/series/.test(n)) return "GDP";
  if (/cik/.test(n)) return "AAPL";
  if (/prompt/.test(n)) return "a small red circle on a white background";
  if (/question|message|content|user_/.test(n)) return "What is Bitcoin? Answer in one sentence.";
  if (/username|handle|screen_name|twitter/.test(n)) return "heurist_ai";
  if (/url|link/.test(n)) return "https://example.com";
  if (/query|search|keyword|q$|term|topic/.test(n)) return "bitcoin";
  if (/limit|count|top_?k|max_?results|num/.test(n)) return 5;
  if (/days|period|lookback/.test(n)) return t === "string" ? "7d" : 7;
  // type fallback
  if (t === "integer" || t === "number") return 1;
  if (t === "boolean") return false;
  if (t === "array") return ["bitcoin"];
  if (prop?.enum?.length) return prop.enum[0];
  return "test";
}
// per-label input overrides where the generic mapper sends an invalid value (valid values come from the
// tool's enum/description). Label = `heurist-${slug(agentId)}-${slug(toolName)}`.
const OVERRIDES = {
  "heurist-fredmacroagent-macro-series-snapshot": { series_key: "core_cpi" },
  "heurist-fredmacroagent-macro-series-history": { series_key: "core_cpi", period: "1y" },
  "heurist-fredmacroagent-macro-vintage-history": { series_key: "core_cpi", realtime_date: "2025-01-01" },
  "heurist-yahoofinanceagent-equity-screen": { screen_name: "most_actives" },
  "heurist-projectknowledgeagent-get-project": { symbol: "BTC" },
  "heurist-secedgaragent-xbrl-fact-trends": { query: "AAPL", metric: "revenue" },
  "heurist-twitterintelligenceagent-user-timeline": { identifier: "@heurist_ai" },
  "heurist-wanvideogenagent-image-to-video-plus-480p-5s": { prompt: "a gentle slow zoom in", image_url: "https://picsum.photos/seed/heurist/512" },
  "heurist-wanvideogenagent-image-to-video-flash-480p-5s": { prompt: "a gentle slow zoom in", image_url: "https://picsum.photos/seed/heurist/512" },
  "heurist-wanvideogenagent-image-to-video-with-audio-480p-5s": { prompt: "a gentle slow zoom in", image_url: "https://picsum.photos/seed/heurist/512" },
  "heurist-firecrawlsearchdigestagent-firecrawl-extract-web-data": { urls: ["https://www.heurist.ai"], extraction_prompt: "the page title and main heading" },
};
// detect a charge-then-error body (HTTP 200 but the agent returned an error) so we don't mark it verified
function bodyHasError(label) {
  const p = join(ART, `${label}.json`); if (!existsSync(p)) return null;
  try { const j = JSON.parse(readFileSync(p, "utf8")); const r = j.result ?? j; const e = (r && typeof r === "object") ? (r.error || r.errors || (r.data && r.data.error)) : null; const top = j.error || j.detail; return e || top || null; } catch { return null; }
}

// build a minimal valid body from a tool's JSON-schema parameters; null = needs a job-id (skip)
function buildBody(params) {
  const props = params?.properties || {};
  const req = params?.required || [];
  const body = {};
  for (const k of req) {
    const v = valueFor(k, props[k]);
    if (v === undefined) return null; // a required job-id-type param we can't supply
    body[k] = v;
  }
  return body;
}

function pay({ url, body, label }) {
  const meta = join(ART, `${label}.meta.json`), artifact = join(ART, `${label}.json`);
  if (existsSync(meta)) { const p = JSON.parse(readFileSync(meta, "utf8")); if (p.ok || p.classification === "needs-input") { console.log(`  · skip (done): ${label}`); return p; } }
  const args = [join(ROOT, "scripts/registry/dist/qa-pay.mjs"), `--url=${url}`, `--method=POST`, `--cap=${CAP}`, `--save=${artifact}`, `--label=${label}`, `--body=${JSON.stringify(body)}`];
  if (DRY) { console.log(`  DRY ${label}: ${JSON.stringify(body)}`); return null; }
  let line;
  try { const out = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, QA_SPRINT_CEILING: "12", QA_SPRINT_PREFIX: "heurist-" } }); line = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); }
  catch (e) { line = { label, classification: "exception", ok: false, error: String(e.message || e).slice(0, 140) }; }
  const errBody = line.ok ? bodyHasError(label) : null; // HTTP 200 but agent returned an error → not verified
  if (errBody) { line.ok = false; line.classification = "error-body"; line.errorBody = String(typeof errBody === "object" ? JSON.stringify(errBody) : errBody).slice(0, 200); }
  writeFileSync(meta, JSON.stringify({ ...line, url, label, body }, null, 2));
  console.log(`  ${line.ok ? "✓" : "✗"} ${label}: ${line.classification}${line.costUsd != null ? " $" + line.costUsd : ""}${line.status ? " [" + line.status + "]" : ""}${line.errorBody ? " — " + line.errorBody.slice(0, 70) : ""}`);
  return line;
}

// ---- discover live agents + schemas ----
const agentsRes = await fetch(`${BASE}/x402/agents`, { headers: { "User-Agent": UA, Accept: "application/json" } }).then((r) => r.json());
let ids = (agentsRes.agents || []).map((a) => a.agentId).filter(Boolean).filter((id) => id !== "debug");
if (ONLY.length) ids = ids.filter((id) => ONLY.includes(id));
const schemaRes = await fetch(`${BASE}/mesh_schema?` + ids.map((i) => `agent_id=${i}`).join("&"), { headers: { "User-Agent": UA, Accept: "application/json" } }).then((r) => r.json());
const schemas = schemaRes.agents || {};

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
let n = 0, ok = 0, paid = 0, needs = 0;
console.log(`\n=== heurist-paytest: ${ids.length} agents cap=$${CAP} ${DRY ? "(DRY)" : ""} ===`);
for (const id of ids) {
  const tools = schemas[id]?.tools || [];
  console.log(`\n# ${id} (${tools.length} tools)`);
  for (const tool of tools) {
    n++;
    const label = `heurist-${slug(id)}-${slug(tool.name)}`;
    const body = OVERRIDES[label] || buildBody(tool.parameters);
    const url = `${BASE}/x402/agents/${id}/${tool.name}`;
    if (body === null) { needs++; if (!DRY) writeFileSync(join(ART, `${label}.meta.json`), JSON.stringify({ label, classification: "needs-input", reason: "requires a job-id from a prior submit call", url })); console.log(`  ⊘ needs-input: ${label} (job-id param)`); continue; }
    const r = pay({ url, body, label });
    if (r?.ok) { ok++; paid += r.costUsd || 0; }
  }
}
console.log(`\n--- heurist: ${n} tools | ${ok} ok | ${needs} needs-input | ~$${paid.toFixed(4)} on qa-pay self-report ---`);
