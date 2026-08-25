// scripts/registry/qa-pay.mts
import * as fs from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

// src/lib/wallet.ts
import { SpongeWallet, SpongePlatform, SpongeApiError } from "@paysponge/sdk";
import * as os from "node:os";
import * as path from "node:path";

// src/lib/siwx.ts
import { HttpClient } from "@paysponge/sdk";
var SIWX_HEADER = process.env.SIWX_HEADER_NAME || "Sign-In-With-X";
function siwxAvailable() {
  return !!process.env.SPONGE_API_KEY;
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function parseMaybeB64Json(s) {
  try {
    return JSON.parse(s);
  } catch {
  }
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return void 0;
  }
}
function readHeader(headers, name) {
  if (!headers) return void 0;
  if (typeof headers.get === "function") return headers.get(name) ?? void 0;
  const rec = headers;
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k];
  return void 0;
}
function extractSiwxInfo(parsed) {
  if (!isRecord(parsed)) return void 0;
  const ext = isRecord(parsed.extensions) ? parsed.extensions : parsed;
  const siwx = isRecord(ext) && isRecord(ext["sign-in-with-x"]) ? ext["sign-in-with-x"] : void 0;
  const info = siwx && isRecord(siwx.info) ? siwx.info : void 0;
  if (!info) return void 0;
  const domain = asStr(info.domain);
  const uri = asStr(info.uri);
  if (!domain || !uri) return void 0;
  return {
    domain,
    uri,
    version: asStr(info.version),
    chainId: asStr(info.chainId),
    type: asStr(info.type),
    nonce: asStr(info.nonce),
    issuedAt: asStr(info.issuedAt),
    expirationTime: asStr(info.expirationTime),
    statement: asStr(info.statement)
  };
}
function detectSiwxChallenge(input) {
  const fromBody = extractSiwxInfo(input.body);
  if (fromBody) return { required: true, info: fromBody };
  const hdr = readHeader(input.headers, "payment-required") ?? readHeader(input.headers, "x-payment-required");
  if (hdr) {
    const fromHdr = extractSiwxInfo(parseMaybeB64Json(hdr));
    if (fromHdr) return { required: true, info: fromHdr };
  }
  if (isRecord(input.body)) {
    const err = asStr(input.body.error) ?? asStr(input.body.message);
    if (err && /siwx|sign[-\s]?in[-\s]?with[-\s]?x/i.test(err)) return { required: true };
  }
  return { required: false };
}
async function signSiwx(info) {
  const apiKey = process.env.SPONGE_API_KEY;
  if (!apiKey) return null;
  if (!info?.domain || !info?.uri) return null;
  try {
    const http = new HttpClient({ apiKey, baseUrl: process.env.SPONGE_API_URL || void 0 });
    const chainNum = info.chainId ? Number(String(info.chainId).split(":").pop()) : void 0;
    const siwe = await http.post("/api/siwe/generate", {
      domain: info.domain,
      uri: info.uri,
      ...info.nonce ? { nonce: info.nonce } : {},
      ...info.statement ? { statement: info.statement } : {},
      ...chainNum && Number.isFinite(chainNum) ? { chain_id: chainNum } : {},
      ...info.expirationTime ? { expiration_time: info.expirationTime } : {}
    });
    const address = asStr(siwe.address);
    const signature = asStr(siwe.signature);
    if (!address || !signature) return null;
    const nonce = info.nonce ?? asStr(siwe.nonce);
    const payload = {
      domain: info.domain,
      address,
      statement: info.statement,
      uri: info.uri,
      version: info.version ?? asStr(siwe.version) ?? "1",
      chainId: info.chainId ?? "eip155:8453",
      type: info.type ?? "eip191",
      nonce,
      issuedAt: asStr(siwe.issuedAt) ?? info.issuedAt,
      expirationTime: asStr(siwe.expirationTime) ?? info.expirationTime,
      signature
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    return { headers: { [SIWX_HEADER]: b64 }, address, nonce: nonce ?? "" };
  } catch {
    return null;
  }
}

// src/lib/wallet.ts
var USDC_DECIMALS = 6;
var SPONGE_CREDENTIALS_CACHE = path.join(os.tmpdir(), "masterkey-sponge-credentials.json");
process.env.SPONGE_CREDENTIALS_PATH ||= SPONGE_CREDENTIALS_CACHE;
var PAY_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
var PaymentExceededError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PaymentExceededError";
  }
};
var WalletPaymentError = class extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletPaymentError";
    this.code = code;
  }
};
var MASTER_AGENT_NAME = "masterkey-master";
var _walletPromise;
function getMasterWallet() {
  if (!_walletPromise) {
    _walletPromise = connectMasterWallet().catch((e) => {
      _walletPromise = void 0;
      throw e;
    });
  }
  return _walletPromise;
}
async function connectMasterWallet() {
  const baseUrl = process.env.SPONGE_API_URL || void 0;
  const apiKey = process.env.SPONGE_API_KEY;
  if (apiKey) {
    return SpongeWallet.connect({
      apiKey,
      agentId: process.env.SPONGE_AGENT_ID || void 0,
      baseUrl,
      noBrowser: true,
      credentialsPath: SPONGE_CREDENTIALS_CACHE
    });
  }
  const masterKey = process.env.SPONGE_MASTER_KEY;
  if (masterKey) {
    const platform = await SpongePlatform.connect({ apiKey: masterKey, baseUrl });
    const agents = await platform.listAgents();
    let agent = agents.find((a) => a.name === MASTER_AGENT_NAME) ?? agents[0];
    let agentKey;
    if (agent) {
      agentKey = await platform.getAgentApiKey(agent.id) ?? await platform.regenerateAgentApiKey(agent.id);
    } else {
      const created = await platform.createAgent({
        name: MASTER_AGENT_NAME,
        description: "MasterKey platform master wallet"
      });
      agent = created.agent;
      agentKey = created.apiKey;
    }
    return platform.connectAgent({ apiKey: agentKey, agentId: agent.id });
  }
  throw new Error("Sponge master wallet not configured: set SPONGE_API_KEY (or SPONGE_MASTER_KEY)");
}
async function payProvider(opts) {
  const method = (opts.method || "GET").toUpperCase();
  const safeMethod = PAY_METHODS.includes(method) ? method : "GET";
  const reqHeaders = { "Content-Type": "application/json", ...opts.headers ?? {} };
  const init = { method: safeMethod, headers: reqHeaders };
  if (opts.body != null && safeMethod !== "GET") {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const overCeiling = (q) => Number(q) / 10 ** USDC_DECIMALS > opts.maxValueUsd;
  const ceilingError = (q) => new PaymentExceededError(
    `provider price ${Number(q) / 10 ** USDC_DECIMALS} USD exceeds per-call ceiling ${opts.maxValueUsd} USD`
  );
  let pre;
  try {
    pre = await fetch(opts.url, init);
  } catch (e) {
    throw new WalletPaymentError(`provider request failed: ${redact(errMsg(e))}`);
  }
  const preText = await safeText(pre);
  if (pre.ok) {
    return { ...passthrough(preText), status: pre.status, contentType: pre.headers.get("content-type") };
  }
  let payHeaders = opts.headers;
  let quoteAtomic = null;
  let signedSiwx = false;
  const siwx = detectSiwxChallenge({ status: pre.status, body: parseBody(preText), headers: pre.headers });
  if (siwx.required || opts.siwxHint === "siwx") {
    if (siwx.info) {
      if (!siwxAvailable()) {
        throw new WalletPaymentError("service requires SIWX authentication but SPONGE_API_KEY is not set");
      }
      const auth = await signSiwx(siwx.info);
      if (!auth) throw new WalletPaymentError("SIWX signing failed for this service");
      const siwxQuote = readX402Quote(pre, preText);
      if (siwxQuote == null) {
        const init2 = { method: safeMethod, headers: { ...reqHeaders, ...auth.headers } };
        if (init.body != null) init2.body = init.body;
        let r;
        try {
          r = await fetch(opts.url, init2);
        } catch (e) {
          throw new WalletPaymentError(`provider request failed (SIWX): ${redact(errMsg(e))}`);
        }
        const t = await safeText(r);
        return {
          ok: r.ok,
          status: r.status,
          body: parseBody(t),
          costUsd: 0,
          paid: false,
          confirmed: false,
          network: "",
          contentType: r.headers.get("content-type")
        };
      }
      if (overCeiling(siwxQuote)) throw ceilingError(siwxQuote);
      quoteAtomic = siwxQuote;
      payHeaders = { ...opts.headers ?? {}, ...auth.headers };
      signedSiwx = true;
    }
  }
  if (!signedSiwx && pre.status === 402) {
    quoteAtomic = readX402Quote(pre, preText);
    if (quoteAtomic != null && overCeiling(quoteAtomic)) throw ceilingError(quoteAtomic);
  }
  if (opts.requireChallenge && !signedSiwx && pre.status !== 402) {
    return {
      ok: false,
      status: pre.status,
      body: parseBody(preText),
      costUsd: 0,
      paid: false,
      confirmed: false,
      network: "",
      contentType: pre.headers.get("content-type")
    };
  }
  const wallet = await getMasterWallet();
  const chain = toSpongeChain(opts.preferredChain);
  let resp;
  try {
    resp = await payViaSponge(wallet, {
      url: opts.url,
      method: safeMethod,
      headers: payHeaders,
      body: opts.body,
      ...chain ? { chain } : {}
    });
  } catch (e) {
    throw mapSpongeError(e);
  }
  return mapPaidFetchResult(resp, { fallbackChain: chain, wallet });
}
function isPreSettlementBodyReuseError(e) {
  const msg = errMsg(e).toLowerCase();
  return /body (has )?(already been|already) (used|read)|body is unusable|request with a (get|head)|bodyused/.test(msg);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function payViaSponge(wallet, req) {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [400, 1200];
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await wallet.paidFetch(req);
    } catch (e) {
      lastErr = e;
      if (!isPreSettlementBodyReuseError(e) || attempt === MAX_ATTEMPTS - 1) throw e;
      await sleep(BACKOFF_MS[attempt] ?? 1200);
    }
  }
  throw lastErr;
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
function parseBody(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}
function passthrough(rawText) {
  return { ok: true, body: parseBody(rawText), costUsd: 0, paid: false, confirmed: false, network: "" };
}
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return void 0;
}
function asStr2(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function decodeSettlementReceipt(headers) {
  const raw = asStr2(headers?.["x-payment-response"]) ?? asStr2(headers?.["X-Payment-Response"]);
  if (!raw) return void 0;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!isRecord2(json)) return void 0;
    return {
      success: typeof json.success === "boolean" ? json.success : void 0,
      transaction: asStr2(json.transaction),
      payer: asStr2(json.payer),
      network: asStr2(json.network)
    };
  } catch {
    return void 0;
  }
}
async function recoverTxHashFromHistory(wallet, costUsd, network) {
  const chain = toSpongeChain(network);
  if (!chain || !(costUsd > 0)) return void 0;
  const atomic = String(Math.round(costUsd * 1e6));
  let rows;
  try {
    rows = await wallet.getTransactionHistoryDetailed({ limit: 25 });
  } catch {
    return void 0;
  }
  const list = Array.isArray(rows) ? rows : isRecord2(rows) ? rows.transactions ?? rows.data ?? rows.items ?? [] : [];
  const cutoff = Date.now() - 18e4;
  const matches = list.filter((t) => {
    if (!isRecord2(t)) return false;
    const dir = asStr2(t.direction) ?? asStr2(t.type);
    const val = asStr2(t.value) ?? asStr2(t.amount);
    const ch = asStr2(t.chain);
    const tsRaw = asStr2(t.timestamp) ?? asStr2(t.createdAt);
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    return dir === "sent" && val === atomic && (!ch || ch === chain) && (Number.isNaN(ts) || ts >= cutoff);
  });
  if (matches.length !== 1) return void 0;
  const m = matches[0];
  return asStr2(m.txHash) ?? asStr2(m.transactionHash) ?? asStr2(m.hash) ?? asStr2(m.transaction);
}
async function mapPaidFetchResult(resp, ctx) {
  const r = isRecord2(resp) ? resp : {};
  const pd = isRecord2(r.payment_details) && r.payment_details || isRecord2(r.payment) && r.payment || void 0;
  const route = isRecord2(r.route) ? r.route : void 0;
  const headers = isRecord2(r.headers) ? r.headers : void 0;
  const receipt = decodeSettlementReceipt(headers);
  const paid = r.payment_made === true || r.paymentMade === true || receipt?.success === true;
  let costUsd = 0;
  if (paid) {
    costUsd = asNum(pd?.amount) ?? asNum(pd?.usdValue) ?? asNum(r.amount) ?? 0;
  }
  const network = asStr2(pd?.chain) ?? asStr2(route?.selected_chain) ?? asStr2(r.chain) ?? (paid ? ctx.fallbackChain ?? "" : "");
  let txHash = asStr2(pd?.txHash) ?? asStr2(pd?.transactionHash) ?? asStr2(pd?.transaction) ?? asStr2(pd?.tx_hash) ?? asStr2(pd?.hash) ?? asStr2(r.txHash) ?? asStr2(r.transactionHash) ?? receipt?.transaction;
  if (paid && !txHash && costUsd > 0) {
    txHash = await recoverTxHashFromHistory(ctx.wallet, costUsd, network);
  }
  const ok = typeof r.ok === "boolean" ? r.ok : true;
  const status = asNum(r.status) ?? (ok ? 200 : 502);
  const body = "data" in r ? r.data : "body" in r ? r.body : r;
  const contentType = asStr2(r.content_type) ?? asStr2(r.contentType) ?? asStr2(headers?.["content-type"]) ?? (isRecord2(body) || Array.isArray(body) ? "application/json" : null);
  let confirmed = paid && !!txHash && receipt?.success !== false;
  if (confirmed && txHash) {
    const chain = toSpongeChain(network);
    if (chain) {
      try {
        const st = await ctx.wallet.getTransactionStatus(txHash, chain);
        if (st?.status === "failed") confirmed = false;
      } catch {
      }
    }
  }
  return { ok, status, body, costUsd, paid, confirmed, network, txHash, contentType };
}
function readX402Quote(res, rawText) {
  const amounts = [];
  const collect = (obj) => {
    if (!isRecord2(obj)) return;
    const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
    for (const a of accepts) {
      if (!isRecord2(a)) continue;
      const v = a.maxAmountRequired ?? a.amount;
      const b = toAtomic(v);
      if (b != null) amounts.push(b);
    }
    const top = toAtomic(obj.maxAmountRequired ?? obj.amount);
    if (top != null) amounts.push(top);
  };
  collect(parseBody(rawText));
  const hdr = res.headers.get("payment-required") || res.headers.get("x-payment-required");
  if (hdr) {
    collect(parseBody(hdr));
    try {
      collect(JSON.parse(Buffer.from(hdr, "base64").toString("utf8")));
    } catch {
    }
  }
  if (!amounts.length) return null;
  return amounts.reduce((min, x) => x < min ? x : min);
}
function toAtomic(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    try {
      return BigInt(v.trim());
    } catch {
      return null;
    }
  }
  return null;
}
function toSpongeChain(net) {
  if (!net) return void 0;
  const n = net.toLowerCase();
  const exact = {
    base: "base",
    "eip155:8453": "base",
    ethereum: "ethereum",
    eth: "ethereum",
    "eip155:1": "ethereum",
    solana: "solana",
    tempo: "tempo"
  };
  if (exact[n]) return exact[n];
  if (n.includes("8453") || n.includes("base")) return "base";
  if (n.includes("solana") || n.startsWith("sol")) return "solana";
  if (n.includes("tempo")) return "tempo";
  if (n.includes("ethereum") || n === "eip155:1") return "ethereum";
  return void 0;
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
function redact(s) {
  return s.replace(/sponge_(live|master)_[A-Za-z0-9]+/g, "sponge_$1_***");
}
function mapSpongeError(e) {
  if (e instanceof PaymentExceededError) return e;
  const code = e instanceof SpongeApiError ? e.errorCode : void 0;
  const msg = redact(errMsg(e));
  if (code === "insufficient_funds" || /insufficient|not enough|balance|fund/i.test(msg)) {
    return new WalletPaymentError(`master wallet has insufficient funds: ${msg}`, code ?? "insufficient_funds");
  }
  if (/limit|exceed/i.test(msg)) {
    return new WalletPaymentError(`Sponge spending limit reached: ${msg}`, code ?? "over_limit");
  }
  return new WalletPaymentError(`Sponge payment failed: ${msg}`, code);
}

// scripts/registry/qa-pay.mts
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
function findRoot() {
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path2.join(dir, ".env.local")) || fs.existsSync(path2.join(dir, "package.json"))) return dir;
      const up = path2.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return process.cwd();
}
var ROOT = findRoot();
for (const f of [".env.local", ".env"]) {
  const p = path2.join(ROOT, f);
  if (fs.existsSync(p)) dotenv.config({ path: p, quiet: true });
}
function parseArgs(argv) {
  const a = {};
  const headers = [];
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) {
      a[raw.slice(2)] = true;
      continue;
    }
    const key = raw.slice(2, eq);
    const val = raw.slice(eq + 1);
    if (key === "header") headers.push(val);
    else a[key] = val;
  }
  if (headers.length) a.header = headers;
  return a;
}
function asString(v) {
  return typeof v === "string" ? v : void 0;
}
function readBody(spec) {
  if (spec == null) return void 0;
  let text = spec;
  if (spec.startsWith("@")) text = fs.readFileSync(spec.slice(1), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function parseHeaders(spec) {
  if (!spec || !spec.length) return void 0;
  const h = {};
  for (const line of spec) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(h).length ? h : void 0;
}
function previewBody(body) {
  if (body == null) return { bodyPreview: null, bodyType: "null", bodyBytes: 0 };
  if (typeof body === "string") {
    const bytes2 = Buffer.byteLength(body, "utf8");
    const looksB64 = body.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(body.slice(0, 256));
    const isDataUrl = body.startsWith("data:");
    if (isDataUrl || looksB64) {
      return { bodyPreview: `<binary/base64 string, ${bytes2} bytes, starts: ${body.slice(0, 48)}\u2026>`, bodyType: "binary-string", bodyBytes: bytes2 };
    }
    return { bodyPreview: body.length > 2e3 ? body.slice(0, 2e3) + "\u2026[truncated]" : body, bodyType: "string", bodyBytes: bytes2 };
  }
  const seen = /* @__PURE__ */ new WeakSet();
  const trimmed = JSON.parse(
    JSON.stringify(body, (_k, v) => {
      if (typeof v === "string" && v.length > 600) return v.slice(0, 600) + `\u2026[+${v.length - 600} chars]`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    })
  );
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  return { bodyPreview: trimmed, bodyType: Array.isArray(body) ? "array" : "object", bodyBytes: bytes };
}
function extractQuoteUsd(msg) {
  const m = msg.match(/price\s+([\d.]+)\s+USD/i);
  return m ? Number(m[1]) : void 0;
}
function sprintSpentSoFar(prefix) {
  try {
    const logPath = path2.join(ROOT, "data/registry/qa-spend-log.jsonl");
    if (!fs.existsSync(logPath)) return 0;
    let sum = 0;
    for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.label === "string" && r.label.startsWith(prefix) && typeof r.costUsd === "number") sum += r.costUsd;
      } catch {
      }
    }
    return sum;
  } catch {
    return 0;
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = asString(args.url);
  if (!url) {
    process.stdout.write(JSON.stringify({ classification: "exception", error: "missing --url" }) + "\n");
    process.exit(2);
  }
  const method = (asString(args.method) || "GET").toUpperCase();
  let cap = args.cap != null ? Number(asString(args.cap)) : 6;
  const origCap = cap;
  const chain = asString(args.chain) || "base";
  const body = readBody(asString(args.body));
  const headers = parseHeaders(args.header);
  const siwxHint = args.siwx ? "siwx" : void 0;
  const savePath = asString(args.save);
  const out = { url, method, capUsd: cap, label: asString(args.label) };
  const sprintCeiling = process.env.QA_SPRINT_CEILING ? Number(process.env.QA_SPRINT_CEILING) : null;
  const sprintPrefix = process.env.QA_SPRINT_PREFIX || "";
  if (sprintCeiling != null && Number.isFinite(sprintCeiling)) {
    const spent = sprintSpentSoFar(sprintPrefix);
    const remaining = sprintCeiling - spent;
    out.sprintCeilingUsd = sprintCeiling;
    out.sprintSpentUsd = Number(spent.toFixed(6));
    out.sprintRemainingUsd = Number(remaining.toFixed(6));
    if (remaining <= 0) {
      Object.assign(out, { classification: "budget-exhausted", paid: false, ok: false, error: `sprint budget exhausted: $${spent.toFixed(4)} / $${sprintCeiling} (prefix "${sprintPrefix}")` });
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
    }
    cap = Math.min(cap, remaining);
    out.capUsd = cap;
  }
  try {
    const r = await payProvider({ url, method, headers, body, maxValueUsd: cap, preferredChain: chain, siwxHint, requireChallenge: true });
    const { bodyPreview, bodyType, bodyBytes } = previewBody(r.body);
    let artifactPath;
    if (savePath) {
      fs.mkdirSync(path2.dirname(savePath), { recursive: true });
      const raw = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
      fs.writeFileSync(savePath, raw);
      artifactPath = savePath;
    }
    if (r.paid && r.costUsd > 0) {
      try {
        const logPath = path2.join(ROOT, "data/registry/qa-spend-log.jsonl");
        fs.mkdirSync(path2.dirname(logPath), { recursive: true });
        fs.appendFileSync(
          logPath,
          JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), label: asString(args.label) ?? null, url, method, costUsd: r.costUsd, confirmed: r.confirmed, txHash: r.txHash ?? null, network: r.network, status: r.status }) + "\n"
        );
      } catch {
      }
    }
    Object.assign(out, {
      classification: r.paid ? "ok-paid" : r.ok ? "ok-free" : "http-error",
      ok: r.ok,
      status: r.status,
      paid: r.paid,
      confirmed: r.confirmed,
      costUsd: r.costUsd,
      network: r.network,
      txHash: r.txHash ?? null,
      contentType: r.contentType,
      bodyType,
      bodyBytes,
      bodyPreview,
      artifactPath
    });
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0);
  } catch (e) {
    if (e instanceof PaymentExceededError) {
      const quote = extractQuoteUsd(e.message);
      const budgetClamped = cap < origCap && (quote == null || quote <= origCap);
      Object.assign(out, { classification: budgetClamped ? "budget-exhausted" : "over-cap", paid: false, quoteUsd: quote, error: e.message });
    } else if (e instanceof WalletPaymentError) {
      Object.assign(out, { classification: "wallet-error", paid: false, errorCode: e.code ?? null, error: e.message });
    } else {
      Object.assign(out, { classification: "exception", paid: false, error: e instanceof Error ? e.message : String(e) });
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0);
  }
}
void main();
