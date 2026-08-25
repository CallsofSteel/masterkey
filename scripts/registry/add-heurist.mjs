/**
 * add-heurist.mjs — fold the Heurist Mesh agents pay-tested in heurist-paytest.mjs into curation.
 * Model (per owner): each AGENT = one Service (the brand/capability); its tools = operations[].
 * Operated by the Heurist team → service.provider="Heurist", op.team stamped "Heurist" by curate (host).
 * Pulls live mesh_schema (params/description/price), re-probes each tool's 402 (FREE) for accepts, and
 * writes a verified usage block per operation. Async poll-leg tools (job-id) are skipped. Collision guard:
 * if a service slug already exists in the target subcat, suffix " (Heurist)" so we never clobber it.
 *
 * Run: node scripts/registry/add-heurist.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const ART = join(ROOT, "data/registry/qa-artifacts/heurist");
const CUR = join(__dir, "curation");
const DRY = process.argv.includes("--dry");
const TODAY = "2026-06-18";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BASE = "https://mesh.heurist.xyz";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const titleize = (s) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// agentId -> { name (service display), subcat, category }
const AGENTS = {
  AIXBTProjectInfoAgent: ["AIXBT Project Info", "crypto-blockchain-data"],
  AskHeuristAgent: ["Ask Heurist", "llm-chat-apis"],
  BaseUSDCForensicsAgent: ["Base USDC Forensics", "crypto-blockchain-data"],
  CaesarResearchAgent: ["Caesar Research", "ai-semantic-search"],
  ChainbaseAddressLabelAgent: ["Chainbase Address Labels", "crypto-blockchain-data"],
  DefiLlamaAgent: ["DefiLlama", "crypto-blockchain-data"],
  ElfaTwitterIntelligenceAgent: ["Elfa Twitter Intelligence", "social-media-data"],
  EtherscanAgent: ["Etherscan", "crypto-blockchain-data"],
  ExaSearchDigestAgent: ["Exa Search Digest", "web-search-apis"],
  FirecrawlSearchDigestAgent: ["Firecrawl Search Digest", "web-scraping"],
  FredMacroAgent: ["FRED Macro", "stocks-financial-data"],
  FundingRateAgent: ["Funding Rates", "crypto-blockchain-data"],
  GoplusAnalysisAgent: ["GoPlus Token Security", "crypto-blockchain-data"],
  MoniTwitterInsightAgent: ["Moni Twitter Insight", "social-media-data"],
  ProjectKnowledgeAgent: ["Crypto Project Knowledge", "crypto-blockchain-data"],
  SallyHealthAgent: ["Sally Health", "llm-chat-apis"],
  SecEdgarAgent: ["SEC EDGAR", "stocks-financial-data"],
  TokenResolverAgent: ["Token Resolver", "crypto-blockchain-data"],
  TrendingTokenAgent: ["Trending Tokens", "crypto-blockchain-data"],
  TwitterIntelligenceAgent: ["Twitter Intelligence", "social-media-data"],
  WanVideoGenAgent: ["Wan Video Gen", "video-generation"],
  YahooFinanceAgent: ["Yahoo Finance", "stocks-financial-data"],
  ZerionWalletAnalysisAgent: ["Zerion Wallet Analysis", "crypto-blockchain-data"],
};
const TAGS = { "crypto-blockchain-data": ["crypto", "onchain"], "stocks-financial-data": ["finance", "market-data"], "social-media-data": ["twitter", "social"], "web-search-apis": ["web-search"], "web-scraping": ["scraping", "web-data"], "ai-semantic-search": ["research", "ai"], "llm-chat-apis": ["llm", "chat"], "video-generation": ["video", "generation"] };

const SPEND = {};
for (const l of readFileSync(join(ROOT, "data/registry/qa-spend-log.jsonl"), "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.label) SPEND[j.label] = j; } catch {} }

function exampleVal(name, prop) {
  const n = name.toLowerCase(), t = prop?.type;
  if (/chain_?id/.test(n)) return t === "integer" || t === "number" ? 8453 : "8453";
  if (/chain|network/.test(n)) return "base";
  if (/contract|token_address/.test(n)) return WETH;
  if (/wallet|address|account|owner|holder/.test(n)) return VITALIK;
  if (/protocol/.test(n)) return "aave-v3";
  if (/symbol|ticker/.test(n)) return n.endsWith("s") ? ["AAPL"] : "AAPL";
  if (/coin|coingecko|token_id|token\b/.test(n)) return "bitcoin";
  if (/series/.test(n)) return "GDP";
  if (/prompt/.test(n)) return "a small red circle on a white background";
  if (/question|message|content|user_/.test(n)) return "What is Bitcoin? Answer in one sentence.";
  if (/username|handle|screen_name|twitter/.test(n)) return "heurist_ai";
  if (/url|link/.test(n)) return "https://example.com";
  if (/query|search|keyword|term|topic/.test(n)) return "bitcoin";
  if (/limit|count|top_?k|max_?results|num/.test(n)) return 5;
  if (t === "integer" || t === "number") return 1;
  if (t === "boolean") return false;
  if (t === "array") return ["bitcoin"];
  if (prop?.enum?.length) return prop.enum[0];
  return "test";
}
function exampleBody(params) { const out = {}; for (const k of params?.required || []) out[k] = exampleVal(k, (params.properties || {})[k]); return out; }
function isJobIdTool(params) { return (params?.required || []).some((k) => /job_?id|task_?id|request_?id|research_?id|run_?id/.test(k.toLowerCase())); }

function extractAccepts(pr, body) {
  const norm = (a) => Array.isArray(a) && a.length && a.every((x) => (x.amount ?? x.maxAmountRequired) && x.asset && x.network)
    ? a.map((x) => ({ scheme: x.scheme || "exact", network: x.network, asset: x.asset, amount: String(x.amount ?? x.maxAmountRequired), payTo: x.payTo, maxTimeoutSeconds: x.maxTimeoutSeconds, ...(x.extra ? { extra: x.extra } : {}) })) : null;
  return norm(pr?.accepts) || norm(body?.accepts) || null;
}
async function probeAccepts(url) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
    const h = r.headers.get("payment-required"); let pr = null; if (h) { try { pr = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
    let body = null; try { body = JSON.parse(await r.text()); } catch {}
    const accepts = extractAccepts(pr, body) || [];
    const amt = accepts[0] ? Number(accepts[0].amount) / 1e6 : null;
    return { accepts, amount: amt };
  } catch { return { accepts: [], amount: null }; }
}
function outShape(label) { const p = join(ART, `${label}.json`); if (!existsSync(p)) return "body.result"; try { const j = JSON.parse(readFileSync(p, "utf8")); if (j && typeof j === "object") { if ("result" in j) return "body.result"; if ("data" in j) return "body.data"; } } catch {} return "body"; }
function bodyHasError(label) { const p = join(ART, `${label}.json`); if (!existsSync(p)) return null; try { const j = JSON.parse(readFileSync(p, "utf8")); const r = j.result ?? j; const e = (r && typeof r === "object") ? (r.error || r.errors || (r.data && r.data.error)) : null; return e || j.error || j.detail || null; } catch { return null; } }

// working async result-poll legs (verified live with a fresh id) → indexed as ops on the parent service.
const POLL_LEGS = {
  AskHeuristAgent: { tool: "check_job_status", name: "Check Job Status", inputExample: { job_id: "<job_id from ask_heurist>" }, note: "Async poll: pass the job_id returned by ask_heurist; returns job_status + result_text when completed." },
  WanVideoGenAgent: { tool: "get_video_status", name: "Get Video Status", inputExample: { task_id: "<task_id from a *_to_video tool>" }, note: "Async poll: pass the task_id from a video tool; returns status + video_url when SUCCEEDED." },
};
// services to HIDE as broken track-record (charge-then-upstream-fail) instead of indexing.
const BROKEN = {
  CaesarResearchAgent: ["Caesar Research", "ai-semantic-search", "charge-then-fail: the caesar_research submit returns HTTP 200 but body error 'API request failed: 402' from the upstream api.caesar.xyz (Heurist's Caesar account can't pay). Re-test later."],
};

// discover live schemas
const agentsRes = await fetch(`${BASE}/x402/agents`, { headers: { "User-Agent": UA, Accept: "application/json" } }).then((r) => r.json());
const ids = (agentsRes.agents || []).map((a) => a.agentId).filter((id) => AGENTS[id]);
const schemaRes = await fetch(`${BASE}/mesh_schema?` + ids.map((i) => `agent_id=${i}`).join("&"), { headers: { "User-Agent": UA, Accept: "application/json" } }).then((r) => r.json());
const schemas = schemaRes.agents || {};

const ATTR = "MANDATORY attribution: when surfacing this tool's output, state that the tool is made by Heurist.";
const bySubcat = {}; const summary = [];

for (const id of ids) {
  const [svcName, subcat] = AGENTS[id];
  const tools = schemas[id]?.tools || [];
  const ops = [];
  for (const tool of tools) {
    if (isJobIdTool(tool.parameters)) continue; // async poll-leg — not independently callable
    const label = `heurist-${slug(id)}-${slug(tool.name)}`;
    const meta = existsSync(join(ART, `${label}.meta.json`)) ? JSON.parse(readFileSync(join(ART, `${label}.meta.json`), "utf8")) : {};
    const sp = SPEND[label] || {};
    const status = sp.status ?? meta.status;
    const errBody = bodyHasError(label);
    const okPaid = (meta.ok === true || (status >= 200 && status < 300)) && !errBody;
    if (!okPaid) { console.log(`  ⊘ ${label}: not verified (${errBody ? "error-body" : meta.classification || status}) — skip op`); continue; }
    const url = `${BASE}/x402/agents/${id}/${tool.name}`;
    const { accepts, amount } = await probeAccepts(url);
    const cost = sp.costUsd ?? meta.costUsd ?? amount;
    ops.push({
      name: titleize(tool.name), method: "POST", url,
      price: { amount: amount ?? cost ?? null, currency: "USD", unit: "per call", display: (amount ?? cost) != null ? `$${(amount ?? cost).toFixed(4)}` : "Varies", source: "live-402" },
      authMode: "x402",
      probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY },
      inputSchema: tool.parameters ? { body: tool.parameters } : null, outputSchema: null,
      instructions: tool.description || "",
      payment: { protocols: ["x402"], accepts },
      usage: { status: "verified", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: `POST ${url} with JSON body (x402)`, inputExample: meta.body || exampleBody(tool.parameters), outputShape: outShape(label), quirks: ["Heurist Mesh agent tool — keyless x402 on Base.", ATTR], guide: tool.description || `${svcName} — ${tool.name}`, costObservedUsd: sp.costUsd ?? meta.costUsd ?? null },
    });
  }
  // append a verified async result-poll leg, if any
  const pl = POLL_LEGS[id];
  if (pl) {
    const url = `${BASE}/x402/agents/${id}/${pl.tool}`; const label = `heurist-${slug(id)}-${slug(pl.tool)}`;
    if (existsSync(join(ART, `${label}.json`)) && !bodyHasError(label)) {
      const sp = SPEND[label] || {}; const { accepts, amount } = await probeAccepts(url);
      const cost = sp.costUsd ?? amount;
      ops.push({ name: pl.name, method: "POST", url, price: { amount: amount ?? cost ?? null, currency: "USD", unit: "per call", display: (amount ?? cost) != null ? `$${(amount ?? cost).toFixed(4)}` : "Varies", source: "live-402" }, authMode: "x402", probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, instructions: pl.note, payment: { protocols: ["x402"], accepts }, usage: { status: "verified", verifiedAt: TODAY, resultPull: "sync", auth: "none", callShape: `POST ${url} with the job/task id (x402)`, inputExample: pl.inputExample, outputShape: outShape(label), quirks: ["Heurist Mesh async poll-leg.", pl.note, ATTR], guide: pl.note, costObservedUsd: cost } });
      console.log(`  + ${label}: poll-leg op added`);
    }
  }
  if (!ops.length) { console.log(`  ! ${svcName}: no verified ops`); continue; }
  const entry = {
    name: svcName, kind: "api", provider: "Heurist", providerId: "heurist",
    aka: [id, slug(svcName)], description: `${svcName} via the Heurist Mesh agent gateway (keyless x402 on Base). ${ops.length} tool(s).`,
    tags: ["heurist", ...(TAGS[subcat] || [])], modality: { input: ["text"], output: subcat === "video-generation" ? ["video"] : ["json"] },
    backends: [], operations: ops, docs: "https://mesh.heurist.ai/console/api-portal",
    status: "active",
  };
  (bySubcat[subcat] ||= []).push(entry);
  summary.push(`${subcat} ← ${svcName} (${ops.length} ops)`);
}

// broken agents → hidden track-record (so a prior active entry is replaced, not left stale)
for (const [id, [svcName, subcat, reason]] of Object.entries(BROKEN)) {
  const op = { name: svcName, method: "POST", url: `${BASE}/x402/agents/${id}/${(schemas[id]?.tools || [{}])[0].name || ""}`, price: { amount: null, currency: "USD", unit: "per call", display: "Varies", source: "live-402" }, authMode: "x402", probe: { status: 402, method: "POST", payable: true, free: false, checkedAt: TODAY }, inputSchema: null, outputSchema: null, instructions: reason, payment: { protocols: ["x402"], accepts: [] }, status: "hidden" };
  const entry = { name: svcName, kind: "api", provider: "Heurist", providerId: "heurist", aka: [id, slug(svcName)], description: `${svcName} via Heurist Mesh. NOT CALLABLE: ${reason}`, tags: ["heurist", "broken"], modality: { input: ["text"], output: ["json"] }, backends: [], operations: [op], docs: "https://mesh.heurist.ai/console/api-portal", usage: { status: "broken", verifiedAt: TODAY, resultPull: "none", auth: "none", callShape: "n/a", inputExample: {}, outputShape: "n/a", quirks: [reason], guide: "Not callable — see droppedReason.", droppedReason: reason, costObservedUsd: 0 }, status: "hidden", hiddenReason: "broken" };
  (bySubcat[subcat] ||= []).push(entry);
  summary.push(`${subcat} ← ${svcName} [HIDDEN: broken]`);
}

// merge into curation with collision guard (suffix " (Heurist)" if slug already taken by a different service)
const CAT = { "crypto-blockchain-data": "data-intelligence", "stocks-financial-data": "data-intelligence", "social-media-data": "data-intelligence", "web-search-apis": "search", "web-scraping": "search", "ai-semantic-search": "search", "llm-chat-apis": "ai-ml", "video-generation": "media" };
const affected = new Set();
for (const [subcat, entries] of Object.entries(bySubcat)) {
  const path = join(CUR, subcat + ".json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { subcategory: subcat, category: CAT[subcat] || "data-intelligence", unit: "per call", entries: [] };
  const bySlug = new Map(file.entries.map((e) => [slug(e.name), e]));
  let added = 0, replaced = 0, renamed = 0;
  for (const e of entries) {
    let k = slug(e.name);
    const existing = bySlug.get(k);
    // collision with a NON-Heurist service → rename to "<name> (Heurist)" to avoid clobber
    if (existing && existing.providerId !== "heurist") { e.name = `${e.name} (Heurist)`; e.aka = [...new Set([...(e.aka || []), slug(e.name)])]; k = slug(e.name); renamed++; }
    if (bySlug.has(k) && bySlug.get(k).providerId === "heurist") { file.entries[file.entries.indexOf(bySlug.get(k))] = e; replaced++; }
    else { file.entries.push(e); added++; }
  }
  if (!DRY) writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  affected.add(subcat);
  console.log(`  ${subcat}: +${added} new, ~${replaced} replaced, ${renamed} renamed-on-collision (now ${file.entries.length})`);
}
console.log("\n--- summary ---"); summary.forEach((s) => console.log("  " + s));
console.log(`\nAffected subcats: ${[...affected].join(" ")}`);
console.log(`Next: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
