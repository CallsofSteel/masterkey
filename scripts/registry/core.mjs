// Core engine: fetch+cache, search, probe (browser-UA + method fallback), price/network/hosting, classify.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, ".cache");
const SEARCH = "https://x402-search.vercel.app/api/search";
const DISCOVER = "https://x402-search.vercel.app/api/discover";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let useCache = true;
export function setCache(v) { useCache = v; }

function cacheKey(s) { return createHash("sha1").update(s).digest("hex"); }
function cacheRead(k) {
  if (!useCache) return null;
  const f = join(CACHE_DIR, k + ".json");
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }
  return null;
}
function cacheWrite(k, v) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, k + ".json"), JSON.stringify(v));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { method = "GET", body = null, timeout = 9000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, body, headers, redirect: "manual", signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    return { status: null, headers: new Headers(), text: "", error: String(e?.name || e) };
  } finally {
    clearTimeout(t);
  }
}

// ---- discovery ----
export async function search(q) {
  const k = cacheKey("search:" + q);
  const c = cacheRead(k);
  if (c) return c;
  const { text } = await fetchText(SEARCH + "?q=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
  let out = [];
  try { out = JSON.parse(text).results || []; } catch { out = []; }
  cacheWrite(k, out);
  await sleep(250);
  return out;
}

export async function discover(origin) {
  const k = cacheKey("discover:" + origin);
  const c = cacheRead(k);
  if (c) return c;
  const { text } = await fetchText(DISCOVER + "?origin=" + encodeURIComponent(origin), { headers: { "User-Agent": UA } });
  let out = [];
  try { out = JSON.parse(text).endpoints || []; } catch { out = []; }
  cacheWrite(k, out);
  await sleep(250);
  return out;
}

// ---- probe ----
function decodePaymentRequired(headers) {
  let h = null;
  for (const [k, v] of headers.entries()) if (k.toLowerCase() === "payment-required") h = v;
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

// probe one method; returns {status, accepts?}
async function probeMethod(url, method) {
  const k = cacheKey(`probe:${method}:${url}`);
  const c = cacheRead(k);
  if (c) return c;
  const isBody = ["POST", "PUT", "PATCH"].includes(method);
  const { status, headers } = await fetchText(url, {
    method,
    body: isBody ? "{}" : null,
    headers: { "User-Agent": UA, "Accept": "application/json", ...(isBody ? { "Content-Type": "application/json" } : {}) },
    timeout: 9000,
  });
  let accepts = null;
  if (status === 402) {
    const pr = decodePaymentRequired(headers);
    if (pr?.accepts) accepts = pr.accepts;
  }
  const out = { status, accepts };
  cacheWrite(k, out);
  await sleep(150);
  return out;
}

// Try documented method first, then fall back across GET/POST. OPTIONS/HEAD ignored for verdict.
export async function probe(url, documentedMethod) {
  const order = [];
  const dm = (documentedMethod || "").toUpperCase();
  if (dm && dm !== "OPTIONS" && dm !== "HEAD") order.push(dm);
  for (const m of ["POST", "GET"]) if (!order.includes(m)) order.push(m);
  let last = { status: null, accepts: null }, usedMethod = order[0];
  for (const m of order) {
    const r = await probeMethod(url, m);
    last = r; usedMethod = m;
    if (r.status === 402 || (r.status >= 200 && r.status < 300)) break;
  }
  return { ...last, method: usedMethod };
}

// ---- normalize ----
const NETWORKS = {
  "eip155:8453": "Base", "eip155:1": "Ethereum", "eip155:137": "Polygon",
  "eip155:43114": "Avalanche", "eip155:42161": "Arbitrum", "eip155:10": "Optimism",
};
export function normNetwork(n) {
  if (!n) return "?";
  if (n.startsWith("solana:")) return "Solana";
  return NETWORKS[n] || n;
}

const DECIMALS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC Base
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v": 6, // USDC Solana
  "0xfafddbb3fc7688494971a79cc65dca3ef82079e7": 18, // USDm
};
function assetDecimals(asset) {
  if (!asset) return 6;
  const a = String(asset).toLowerCase();
  if (a === "usdc" || a === "usdc.e" || a === "usd coin") return 6;
  return DECIMALS[a] ?? 6;
}

export function priceFromAccepts(accepts) {
  if (!accepts?.length) return null;
  const usds = [], networks = new Set();
  for (const a of accepts) {
    networks.add(normNetwork(a.network));
    const dec = assetDecimals(a.asset);
    const v = Number(a.amount) / 10 ** dec;
    if (Number.isFinite(v)) usds.push(v);
  }
  let flagged = false;
  const sane = usds.filter((v) => v >= 0 && v <= 100000); // guard wrong-decimals overflow
  if (sane.length !== usds.length) flagged = true;
  if (!sane.length) return { amount: null, networks: [...networks], flagged: true };
  const min = Math.min(...sane), max = Math.max(...sane);
  return { amount: min, min, max, networks: [...networks], flagged };
}

const HOSTING_SUFFIXES = {
  "up.railway.app": "Railway", "railway.app": "Railway", "vercel.app": "Vercel",
  "workers.dev": "Cloudflare Workers", "pages.dev": "Cloudflare Pages", "fly.dev": "Fly.io",
  "onrender.com": "Render", "netlify.app": "Netlify", "deno.dev": "Deno Deploy",
  "hf.space": "HF Spaces", "modal.run": "Modal", "val.run": "Val Town",
  "herokuapp.com": "Heroku", "trycloudflare.com": "Cloudflare Tunnel",
  "replit.app": "Replit", "repl.co": "Replit", "glitch.me": "Glitch", "ngrok.app": "ngrok", "ngrok-free.app": "ngrok",
};
export function detectHosting(host) {
  const h = (host || "").toLowerCase();
  for (const suf of Object.keys(HOSTING_SUFFIXES)) {
    if (h === suf || h.endsWith("." + suf)) return { hosting: "platform", platformName: HOSTING_SUFFIXES[suf] };
  }
  return { hosting: "custom", platformName: null };
}

// best-effort name cleanup; flags low-confidence names
export function cleanName(raw) {
  let n = (raw || "").trim();
  let dirty = false;
  if (/[0-9a-f]{6,}\b/i.test(n)) dirty = true; // hex ids
  n = n.replace(/\s+[0-9a-f]{6,}\b/gi, "");
  n = n.replace(/\s+\d{4,}\b/g, "");
  n = n.replace(/\s+Keys?$/i, "");
  n = n.replace(/\s{2,}/g, " ").trim();
  if (!n) { n = raw; dirty = true; }
  return { name: n, dirty };
}

export function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ""; } }
export function pathOf(u) { try { return new URL(u).pathname.toLowerCase(); } catch { return ""; } }

const INTERNAL_RE = /\/(cron|webhook|webhooks|internal|admin)(\/|$)/;
const TRIVIAL_RE = /\/(models|health|status|ping|version|openapi|\.well-known)(\/|$)/;
export function classifyPath(p) {
  return { internal: INTERNAL_RE.test(p), trivial: TRIVIAL_RE.test(p) };
}

// payment evidence from a search/discover record
export function hasPaymentEvidence(rec) {
  const am = (rec.authMode || "").toLowerCase();
  if (am.includes("x402") || am === "paid" || am === "siwx") return true;
  if (Array.isArray(rec.accepts) && rec.accepts.length) return true;
  const p = String(rec.price ?? "");
  if (/\$?\d/.test(p) && p !== "?") return true;
  return false;
}

// ---- enrichment ----
const CHECK = "https://x402-search.vercel.app/api/check";
export async function checkEndpoint(url) {
  const k = cacheKey("check:" + url);
  const c = cacheRead(k);
  if (c) return c;
  const { text } = await fetchText(CHECK + "?url=" + encodeURIComponent(url), { headers: { "User-Agent": UA }, timeout: 12000 });
  let out = null;
  try { out = JSON.parse(text); } catch { out = null; }
  if (out && out.error) out = null;
  cacheWrite(k, out);
  await sleep(150);
  return out;
}

export async function fetchLlms(origin) {
  const base = (origin || "").replace(/\/+$/, "");
  if (!base) return null;
  const k = cacheKey("llms:" + base);
  const c = cacheRead(k);
  if (c) return c;
  let found = null;
  for (const p of ["/llms.txt", "/llms-full.txt", "/.well-known/llms.txt"]) {
    const { status, text } = await fetchText(base + p, { headers: { "User-Agent": UA }, timeout: 8000 });
    if (status >= 200 && status < 300 && text && text.length > 40 && /[A-Za-z]/.test(text) && !/<html/i.test(text.slice(0, 300))) {
      found = text.slice(0, 6000); break;
    }
  }
  cacheWrite(k, found || "");
  await sleep(120);
  return found;
}
