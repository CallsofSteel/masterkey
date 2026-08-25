// Assemble registry Service[] for a subcategory from candidates + my curation decisions,
// then rebuild the manifest (index.json) + meta.json from all by-subcat files.
// Usage: node scripts/registry/curate.mjs --subcat=image-generation
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATEGORIES } from "./queries.mjs";
import { stampTeams, teamsForService } from "./teams.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../../data/registry");
const args = process.argv.slice(2);
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const SUBCAT = getArg("subcat");

const cand = JSON.parse(readFileSync(join(__dir, "candidates", SUBCAT + ".json"), "utf8"));
const dec = JSON.parse(readFileSync(join(__dir, "curation", SUBCAT + ".json"), "utf8"));
const C = cand.candidates;
// Pricing unit: subcat-level default (dec.unit) or per-entry override (e.unit); falls back to "per call".
// image-generation has no `unit` field and is never re-curated here, so its "per image" output is untouched.
const DEFAULT_UNIT = dec.unit || (SUBCAT === "image-generation" ? "per image" : "per call");

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const HOSTPROV = {
  "x402.orth.sh": "Orthogonal", "orbisapi.com": "Orbis", "api.xona-agent.com": "Xona",
  "stablestudio.dev": "StableStudio", "stablestudio.io": "StableStudio", "x402helper.xyz": "x402 Helper",
  "api.imgzen.dev": "imgzen", "x402.slinkylayer.ai": "SlinkyLayer",
  "x402-gateway-production.up.railway.app": "x402 Gateway",
};
const provFromHost = (h) => HOSTPROV[h] || (h || "").replace(/^api\./, "").split(".").slice(0, -1).join(".") || h;
const fmtAmt = (a) => (a == null ? null : a === 0 ? "Free" : `$${a.toFixed(a < 0.01 ? 4 : a < 1 ? 3 : 2)}`);

// First-party map (data/registry/first-party.json, derived from the agentic-market 1P catalog by
// gen-first-party.mjs). A backend is first-party iff its SERVICE matches a 1P entry by alias AND the
// backend's host is one of that entry's own hosts (e.g. api.exa.ai for the Exa service). The run engine
// defaults to the 1P backend; aggregator routes (blockrun/stableenrich proxying Exa) stay non-1P.
let FP = { entries: [] };
try { FP = JSON.parse(readFileSync(join(__dir, "../../data/registry", "first-party.json"), "utf8")); } catch { /* optional */ }
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
function firstPartyHostsFor(e) {
  const tokens = new Set([e.providerId, e.provider, e.name].map(slug).filter(Boolean));
  const hosts = new Set();
  for (const ent of FP.entries || []) {
    if ((ent.aliases || []).some((a) => tokens.has(a))) for (const h of ent.hosts || []) hosts.add(h);
  }
  return hosts;
}

// ov = agentcash-resolved overrides I supply during curation: { amount, description, inputSchema, outputSchema }
function backendFrom(idx, ov, unit) {
  const c = C[idx];
  if (!c) { console.error("  ! bad candidate index", idx); return null; }
  let amt = c.price?.amount ?? null;
  let source = c.payable ? "live-402" : "search";
  if (ov && ov.amount != null) { amt = ov.amount; source = "agentcash"; }
  const display = amt == null ? "Varies"
    : c.price?.min != null && c.price?.max != null && c.price.max - c.price.min > 1e-9
      ? `$${c.price.min.toFixed(3)}–$${c.price.max.toFixed(3)}` : fmtAmt(amt);
  return {
    provider: provFromHost(c.host), providerId: slug(provFromHost(c.host)),
    url: c.url || c.key, method: (ov?.method || c.method || c.probeMethod || "POST").toUpperCase(),
    modelParam: ov?.modelParam || undefined,
    needsApproval: ov?.needsApproval ?? undefined,
    async: ov?.async || undefined, // RUN_RELIABILITY_SPEC 3.1 — carry the AsyncSpec so rebuilds don't strip it
    hosting: c.hosting, platformName: c.platformName || undefined,
    authMode: c.authMode || "x402",
    price: { amount: amt, currency: "USD", unit, display, min: c.price?.min ?? null, max: c.price?.max ?? null, source, dynamic: !!c.price?.flagged },
    payment: { protocols: ov?.protocols || c.check?.protocols || ["x402"], accepts: c.accepts || [] },
    inputSchema: ov?.inputSchema || c.check?.inputSchema || null, outputSchema: ov?.outputSchema || c.check?.outputSchema || null,
    probe: { status: c.probeStatus, method: c.probeMethod, payable: !!c.payable, free: false, blocked: c.probeStatus != null && c.probeStatus !== 402 && !(c.probeStatus >= 200 && c.probeStatus < 300), checkedAt: cand.generatedAt },
    status: ov?.status || (c.hosting === "platform" ? "needs-review" : "active"),
  };
}

// hosting detection for manual (agentcash-discovered) backends
const HOSTING_SUFFIXES = {
  "up.railway.app": "Railway", "railway.app": "Railway", "vercel.app": "Vercel",
  "workers.dev": "Cloudflare Workers", "pages.dev": "Cloudflare Pages", "fly.dev": "Fly.io",
  "onrender.com": "Render", "netlify.app": "Netlify", "deno.dev": "Deno Deploy", "hf.space": "HF Spaces",
  "modal.run": "Modal", "val.run": "Val Town", "herokuapp.com": "Heroku", "replit.app": "Replit", "repl.co": "Replit",
};
function detectHosting(host) {
  const h = (host || "").toLowerCase();
  for (const s of Object.keys(HOSTING_SUFFIXES)) if (h === s || h.endsWith("." + s)) return { hosting: "platform", platformName: HOSTING_SUFFIXES[s] };
  return { hosting: "custom", platformName: null };
}
// A manual backend = an endpoint I discovered via agentcash (not in the keyword-search candidates).
// spec: { url, method?, provider?, amount?, min?, max?, dynamic?, modelParam?, protocols?, inputSchema?, status? }
function manualBackend(spec, unit) {
  let host = ""; try { host = new URL(spec.url).host.toLowerCase(); } catch {}
  const { hosting, platformName } = detectHosting(host);
  const amt = spec.amount ?? null;
  return {
    provider: spec.provider || provFromHost(host), providerId: slug(spec.provider || provFromHost(host)),
    url: spec.url, method: (spec.method || "POST").toUpperCase(), modelParam: spec.modelParam || undefined,
    needsApproval: spec.needsApproval ?? undefined,
    async: spec.async || undefined, // RUN_RELIABILITY_SPEC 3.1 — carry the AsyncSpec so rebuilds don't strip it
    hosting, platformName: platformName || undefined, authMode: spec.authMode || "x402",
    price: { amount: amt, currency: "USD", unit, display: amt == null ? "Varies" : fmtAmt(amt), min: spec.min ?? null, max: spec.max ?? null, source: "agentcash", dynamic: !!spec.dynamic },
    payment: { protocols: spec.protocols || ["x402"], accepts: spec.accepts || [] },
    inputSchema: spec.inputSchema || null, outputSchema: spec.outputSchema || null,
    probe: { status: 402, method: spec.method || "POST", payable: true, free: false, blocked: false, checkedAt: cand.generatedAt },
    status: spec.status || (hosting === "platform" ? "needs-review" : "active"),
  };
}

// x402-only: MPP (Tempo / paywithlocus) is NOT x402 — drop those backends entirely.
// EXCEPTION: paywithlocus now runs a genuine x402 gateway at x402.paywithlocus.com. That host speaks real
// x402 v2 on Base (paid-verified 2026-08-08) so it is NOT MPP; every OTHER paywithlocus host (and *.mpp.* /
// temponaut) stays MPP-dropped.
const isMpp = (b) => {
  const url = b.url || "";
  const x402Locus = /x402\.paywithlocus\.com/i.test(url);
  return (!x402Locus && /paywithlocus/i.test(url)) || /\.mpp\.|temponaut\.xyz/i.test(url) ||
    ((b.payment?.protocols || []).includes("mpp") && !(b.payment?.protocols || []).includes("x402"));
};

const services = dec.entries.map((e) => {
  const unit = e.unit || DEFAULT_UNIT;
  const seenUrl = new Set();
  const backends = e.backends
    .map((b) => (typeof b === "object" ? manualBackend(b, unit) : backendFrom(b, e.resolved?.[b], unit)))
    .filter(Boolean)
    .filter((b) => (seenUrl.has(b.url.toLowerCase()) ? false : (seenUrl.add(b.url.toLowerCase()), true)))
    .filter((b) => !isMpp(b));
  // Stamp first-party backends (the service owner's own host) so the engine can default to them.
  const fpHosts = firstPartyHostsFor(e);
  if (fpHosts.size) for (const b of backends) { if (fpHosts.has(hostOf(b.url))) b.firstParty = true; }
  if (!backends.length && !(e.operations && e.operations.length)) return null; // no x402 backend -> prune
  const anyCustom = backends.some((b) => b.hosting === "custom");
  // Carry operations from curation (with per-op needsApproval and usage if present)
  const ops = (e.operations || []).map((op) => ({
    ...op,
    needsApproval: op.needsApproval ?? undefined,
    usage: op.usage ?? undefined,
  }));
  // Headline price = cheapest payable unit across backends OR operations (op-only services like the
  // Heurist Mesh agents have no backends but priced operations).
  const amts = [...backends.map((b) => b.price?.amount), ...ops.filter((o) => o.status !== "hidden").map((o) => o.price?.amount)].filter((v) => v != null);
  const best = amts.length ? Math.min(...amts) : null;
  // Stamp operating-team tags by host (BlockRun/Merit/Sponge/Orthogonal/…) — mirrors firstParty; see teams.mjs.
  stampTeams({ backends, operations: ops });
  return {
    id: slug(e.name), kind: e.kind || "model", name: e.name, aka: e.aka || [],
    provider: e.provider, providerId: e.providerId || slug(e.provider),
    description: e.description || "", category: dec.category, subcategory: dec.subcategory,
    tags: e.tags || [], modality: e.modality || { input: ["text"], output: ["text"] },
    pricing: { headline: best == null ? "Varies" : fmtAmt(best), amount: best, currency: "USD", unit },
    operations: ops, backends, docs: e.docs || null,
    usage: e.usage ?? undefined,
    source: { serviceKey: slug(e.name), discoveredVia: cand.queries, lastSyncedAt: cand.generatedAt, hosting: anyCustom ? "custom" : "platform" },
    status: e.status || (anyCustom ? "active" : "needs-review"),
    hiddenReason: e.hiddenReason || undefined,
  };
}).filter(Boolean);

mkdirSync(join(OUT, "by-subcat"), { recursive: true });
writeFileSync(join(OUT, "by-subcat", SUBCAT + ".json"), JSON.stringify(services, null, 2));

// rebuild manifest from all by-subcat files
const bySub = join(OUT, "by-subcat");
const all = [];
for (const f of readdirSync(bySub).filter((f) => f.endsWith(".json")))
  for (const s of JSON.parse(readFileSync(join(bySub, f), "utf8"))) all.push(s);
const catName = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c.name]));
const subName = {}; for (const c of CATEGORIES) for (const s of c.subcategories) subName[s.slug] = s.name;

// --- brand domain derivation (for favicon logos in the UI) ---
// Gateways/marketplaces and PaaS hosts whose favicon is NOT the service's brand → skip.
const GATEWAY_HOST = /(httpay\.xyz|orth\.sh|orbisapi\.com|paysponge\.com|blockrun\.ai|gg402|x402helper|stablestudio|slinkylayer|civicmerge|imgzen|spraay\.app|the402\.ai|questflow\.ai|x402node\.dev|onesource\.io|temponaut|x402-deployer|x402-gateway)/i;
const PLATFORM_HOST = /(vercel\.app|up\.railway\.app|railway\.app|workers\.dev|pages\.dev|fly\.dev|onrender\.com|netlify\.app|deno\.dev|hf\.space|herokuapp\.com|val\.run|a\.run\.app|run\.app|modal\.run|replit\.app|repl\.co|ngrok|trycloudflare\.com)$/i;
// Real-TLD allowlist so model-version akas ("gemini-3.1-pro", "minimax-m2.7") aren't mistaken for domains.
const TLDS = new Set(["com","org","net","io","ai","dev","co","app","sh","xyz","cloud","tech","to","gg","win","fyi","so","fi","uk","me","id","tv","info","finance","markets","network","tokyo","studio","chat","build","live","store","fun","wtf","ee","one","cc","us"]);
const PROVIDER_DOMAINS = {
  "OpenAI": "openai.com", "Anthropic": "anthropic.com", "Google": "google.com", "Mistral": "mistral.ai", "Mistral AI": "mistral.ai",
  "Groq": "groq.com", "Together AI": "together.ai", "Perplexity": "perplexity.ai", "xAI": "x.ai", "DeepSeek": "deepseek.com",
  "Cohere": "cohere.com", "Replicate": "replicate.com", "ElevenLabs": "elevenlabs.io", "Deepgram": "deepgram.com",
  "Stability AI": "stability.ai", "ByteDance": "bytedance.com", "Black Forest Labs": "bfl.ai", "Meta": "meta.com",
  "Alibaba": "alibabacloud.com", "Moonshot AI": "moonshot.ai", "Moonshot": "moonshot.ai", "MiniMax": "minimax.io",
  "OpenRouter": "openrouter.ai", "Zhipu": "z.ai", "Z.AI": "z.ai", "Hugging Face": "huggingface.co", "BlockRun": "blockrun.ai",
  "Ideogram": "ideogram.ai", "Luma AI": "lumalabs.ai", "Luma": "lumalabs.ai", "Runway": "runwayml.com", "HiDream": "hidream.ai",
  "OpenWeather": "openweathermap.org", "Fly.io": "fly.io", "Browser Use": "browser-use.com", "Jina AI": "jina.ai",
  "People Data Labs": "peopledatalabs.com", "2Captcha": "2captcha.com", "Bria": "bria.ai", "Parallel": "parallel.ai",
  "Telegram": "telegram.org", "Discord": "discord.com", "Slack": "slack.com", "Resend": "resend.com",
  "Twilio SendGrid": "sendgrid.com", "SendGrid": "sendgrid.com", "Datadog": "datadoghq.com", "Stripe": "stripe.com",
  "Cloudflare": "cloudflare.com", "Mapbox": "mapbox.com", "Render": "render.com", "Supabase": "supabase.com",
  "Neon": "neon.tech", "Turso": "turso.tech", "Pinata": "pinata.cloud", "Reducto": "reducto.ai",
  "AgentMail": "agentmail.to", "CoinMarketCap": "coinmarketcap.com", "Nansen": "nansen.ai", "QuickNode": "quicknode.com",
  "Exa": "exa.ai", "Apollo": "apollo.io", "Hunter": "hunter.io", "Tavus": "tavus.io", "Twilio": "twilio.com",
  "StablePhone": "stablephone.dev", "StableEmail": "stableemail.dev", "MemoryAPI": "memoryapi.org", "DocPull": "docpull.ai",
  "MakesPDF": "makespdf.com", "Laso Finance": "laso.finance", "StableGiftCards": "stablegiftcards.dev", "Walrus": "walrus.xyz",
};
// Domains DuckDuckGo has no real favicon for — it serves a generic "missing image" placeholder
// (returned even on HTTP 404, so the browser renders it and the UI can't detect the failure).
// Null these so the UI falls back to brand initials. Verified via the DDG icons endpoint.
const NO_FAVICON = new Set([
  "klymax402.com", "2s.io", "dyor.network", "withzero.ai", "dellbot.win", "nichospt.net",
  "btcnode.uk", "x402trustlayer.xyz", "stablebrowser.dev", "strale.io", "apitoll.cloud",
  "docpull.ai", "stablegiftcards.dev", "zclk.cc", "toonhaus.dev", "market.memoryapi.org",
  "stableflowers.dev", "getquali.com", "agentic-jp.com", "trustsource.cc", "reversesandbox.com",
  "agentstatus.tech", "hypercli.com", "melis.ai", "wavespeed.ai",
]);
const regDomain = (host) => {
  const h = host.replace(/^www\./, "").toLowerCase();
  const p = h.split(".");
  return p.length <= 2 ? h : p.slice(-2).join(".");
};
// True only for strings that genuinely look like a registrable domain (real TLD, no version-ish last label).
function looksLikeDomain(t) {
  if (t.includes(" ") || t.includes("/")) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return false;
  const last = t.split(".").pop();
  return /^[a-z]{2,}$/.test(last) && TLDS.has(last); // last label must be a real alphabetic TLD
}
function deriveDomainRaw(s) {
  for (const a of s.aka || []) {
    const t = String(a).trim().toLowerCase().replace(/^www\./, "");
    if (looksLikeDomain(t)) return t;
  }
  if (PROVIDER_DOMAINS[s.provider]) return PROVIDER_DOMAINS[s.provider];
  for (const b of s.backends || []) {
    try {
      const h = new URL(b.url).host.toLowerCase();
      if (!GATEWAY_HOST.test(h) && !PLATFORM_HOST.test(h)) return regDomain(h);
    } catch { /* ignore */ }
  }
  return null;
}
function deriveDomain(s) {
  const d = deriveDomainRaw(s);
  return d && NO_FAVICON.has(d) ? null : d; // no real favicon → null → UI shows initials
}
const shortDesc = (d) => {
  const t = (d || "").trim();
  if (t.length <= 140) return t;
  return t.slice(0, 137).replace(/\s+\S*$/, "") + "…";
};

const tree = {};
const entries = all.map((s) => {
  (tree[s.category] ??= {})[s.subcategory] = (tree[s.category]?.[s.subcategory] || 0) + 1;
  const teams = teamsForService(s);
  return { id: s.id, kind: s.kind, name: s.name, provider: s.provider, category: s.category, subcategory: s.subcategory, price: { display: s.pricing.headline, amount: s.pricing.amount, unit: s.pricing.unit }, tags: s.tags, description: shortDesc(s.description), domain: deriveDomain(s), status: s.status, hiddenReason: s.hiddenReason || undefined, ...(teams.length ? { teams } : {}) };
});
const categories = Object.entries(tree).map(([cs, subs]) => ({
  name: catName[cs] || cs, slug: cs, count: Object.values(subs).reduce((a, b) => a + b, 0),
  subcategories: Object.entries(subs).map(([ss, n]) => ({ name: subName[ss] || ss, slug: ss, count: n })),
}));
// syncedAt is the user-facing "Last synced" date = when the registry was last (re)built. Using the
// per-subcat candidate file's generatedAt made this REGRESS (curating an old-candidate subcat moved the
// global date backwards). Stamp the actual build time instead. (Per-entry provenance stays on source.lastSyncedAt.)
const syncedAt = new Date().toISOString();
writeFileSync(join(OUT, "index.json"), JSON.stringify({ syncedAt, categories, entries }, null, 2));
writeFileSync(join(OUT, "meta.json"), JSON.stringify({ syncedAt, totalServices: all.length, perSubcategory: tree }, null, 2));

console.log(`curated ${SUBCAT}: ${services.length} services · ${services.reduce((n, s) => n + s.backends.length, 0)} backends`);
for (const s of services)
  console.log(`  ${s.name.padEnd(24)} ${s.pricing.headline.padEnd(8)} ${String(s.backends.length)}bk  [${s.backends.map((b) => b.provider).join(", ")}]  ${s.status}`);
