/**
 * add-stablestudio.mjs — index the full StableStudio (stablestudio.dev) route surface into the registry
 * from the authoritative provider doc (stablestudio.md). Adds any missing stablestudio.dev backend as a
 * manual backend object on the matching curation entry (idempotent: skips URLs already present), creates
 * new entries for net-new capabilities (image-to-SVG arrow, sora-2-pro), and attaches the canonical
 * StableStudio usage flow. Then rebuild the affected subcats with curate.mjs.
 *
 * StableStudio flow (all routes): pay POST /api/generate/{model}/{op} → {jobId,status:pending} → poll
 * GET /api/jobs/{jobId} with SIGN-IN-WITH-X (free) until status=complete → result.imageUrl/videoUrl.
 * edit / i2v / vectorize need the 3-step File Upload first (POST /api/upload $0.01 → PUT blob → confirm).
 * Dynamic pricing — headline is the cap; real settle is often far lower (gpt-image-2 edit settled $0.01,
 * wan-2.6 $0.50, both live-verified). Per-model input schema + price range: see stablestudio.md.
 *
 * Usage: node scripts/registry/add-stablestudio.mjs   (then curate the printed subcats)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const CUR = path.join(ROOT, "scripts/registry/curation");
const BASE = "https://stablestudio.dev/api/generate";

const ssUsage = (op, priceRange, inputExample, extra = "") => ({
  status: "untested",
  verifiedAt: "2026-06-09",
  resultPull: "poll",
  auth: "siwx",
  callShape: `POST ${op} (x402, dynamic price ${priceRange}) → {jobId}; then poll GET https://stablestudio.dev/api/jobs/{jobId} with SIGN-IN-WITH-X (free) until status=complete`,
  inputExample,
  outputShape: "POST → body.jobId (+status:pending). Poll GET /api/jobs/{jobId} (SIWX) → body.status, on complete body.result.imageUrl (images) or body.result.videoUrl+thumbnailUrl (video). URLs expire ~20min — download immediately.",
  quirks: [
    `DYNAMIC PRICING: registry/headline is the CAP (${priceRange}); real settle is often far lower (live-verified siblings: gpt-image-2 edit $0.01, wan-2.6 $0.50).`,
    "Two-step async: POST only pays + returns {jobId}; the asset comes from polling GET /api/jobs/{jobId} which is SIWX-auth (free), signed by the SAME wallet that paid.",
    "Per-model input schema, aspect ratios, sizes, and exact price range are in the provider doc stablestudio.md (authoritative).",
    "Pays USDC on Base/Solana/Tempo, no API key.",
    extra,
  ].filter(Boolean),
  needs: [],
  needsApproval: false,
  guide: `StableStudio ${op.replace(BASE + "/", "")}. Pay-per-call x402 on Base (dynamic ${priceRange}). POST returns {jobId}; poll GET /api/jobs/{jobId} with a SIGN-IN-WITH-X signature (free, same wallet) until status=complete, then read result.imageUrl/videoUrl. ${extra} Full per-model input schema + price range: see stablestudio.md (provider-authoritative). Indexed from the provider doc; live pay-test pending.`,
  costObservedUsd: 0,
});

const UPLOAD_NOTE = "EDIT/I2V/VECTORIZE require the File Upload flow first: POST /api/upload ($0.01) → PUT bytes to the returned Vercel Blob → POST /api/upload/confirm (SIWX); use the returned blobUrl in images/image/urls.";

// route additions: [subcat, entryName, [ {url, amount, usage} ... ], newEntryTemplate?]
const ADD = {
  "image-generation": [
    ["Nano Banana (Gemini 2.5 Flash)", [
      [`${BASE}/nano-banana/generate`, 0.045, ssUsage(`${BASE}/nano-banana/generate`, "$0.045–$0.151", { prompt: "a red circle", aspectRatio: "1:1", imageSize: "1K" })],
      [`${BASE}/nano-banana/edit`, 0.045, ssUsage(`${BASE}/nano-banana/edit`, "$0.045–$0.151", { prompt: "add a red circle", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
    ["Nano Banana Pro", [
      [`${BASE}/nano-banana-pro/generate`, 0.13, ssUsage(`${BASE}/nano-banana-pro/generate`, "$0.13–$0.24", { prompt: "a red circle", aspectRatio: "1:1", imageSize: "1K" })],
      [`${BASE}/nano-banana-pro/edit`, 0.13, ssUsage(`${BASE}/nano-banana-pro/edit`, "$0.13–$0.24", { prompt: "add a red circle", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
    ["GPT Image 1.5", [
      [`${BASE}/gpt-image-1.5/edit`, 0.009, ssUsage(`${BASE}/gpt-image-1.5/edit`, "$0.009–$0.20", { prompt: "add a red circle", quality: "low", size: "1024x1024", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
    ["FLUX.2 Pro", [
      [`${BASE}/flux-2-pro/generate`, 0.02, ssUsage(`${BASE}/flux-2-pro/generate`, "$0.02–$0.04", { prompt: "a red circle", aspect_ratio: "1:1", resolution: "1 MP" })],
      [`${BASE}/flux-2-pro/edit`, 0.03, ssUsage(`${BASE}/flux-2-pro/edit`, "$0.03–$0.06", { prompt: "add a red circle", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
    ["FLUX.2 Max", [
      [`${BASE}/flux-2-max/generate`, 0.04, ssUsage(`${BASE}/flux-2-max/generate`, "$0.04–$0.17", { prompt: "a red circle", aspect_ratio: "1:1", resolution: "1 MP" })],
      [`${BASE}/flux-2-max/edit`, 0.04, ssUsage(`${BASE}/flux-2-max/edit`, "$0.04–$0.17", { prompt: "add a red circle", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
    ["Grok Imagine", [
      [`${BASE}/grok/generate`, 0.07, ssUsage(`${BASE}/grok/generate`, "$0.07", { prompt: "a red circle", aspect_ratio: "1:1" })],
      [`${BASE}/grok/edit`, 0.022, ssUsage(`${BASE}/grok/edit`, "$0.022", { prompt: "add a red circle", images: ["<blobUrl>"] }, UPLOAD_NOTE)],
    ]],
  ],
  "video-generation": [
    ["Grok Imagine Video", [
      [`${BASE}/grok-video/generate`, 0.15, ssUsage(`${BASE}/grok-video/generate`, "$0.15–$0.75", { prompt: "a red circle pulsing", duration: "6", resolution: "720p", aspect_ratio: "16:9" })],
    ]],
    ["Seedance 2 Pro", [
      [`${BASE}/seedance/t2v`, 0.45, ssUsage(`${BASE}/seedance/t2v`, "$0.09–$0.54/s", { prompt: "a red circle", duration: "5", aspectRatio: "16:9", outputResolution: "720p" })],
    ]],
    ["Seedance 2.0 Fast", [
      [`${BASE}/seedance-fast/i2v`, 0.08, ssUsage(`${BASE}/seedance-fast/i2v`, "$0.08–$0.17/s", { prompt: "gentle motion", duration: "5", aspectRatio: "16:9", outputResolution: "720p", mode: "keyframe", urls: ["<blobUrl>"], urlMediaTypes: ["image"] }, UPLOAD_NOTE)],
    ]],
    ["Wan 2.6", [
      [`${BASE}/wan-2.6/t2v`, 0.5, ssUsage(`${BASE}/wan-2.6/t2v`, "$0.50–$2.25", { prompt: "a red circle pulsing", duration: "5", size: "1280*720" })],
    ]],
    ["OpenAI Sora 2", [
      [`${BASE}/sora-2/generate`, 0.4, ssUsage(`${BASE}/sora-2/generate`, "$0.40–$1.20", { prompt: "a red circle pulsing", seconds: "4", size: "1280x720" })],
      [`${BASE}/sora-2-pro/generate`, 1.2, ssUsage(`${BASE}/sora-2-pro/generate`, "$1.20–$6.00", { prompt: "a red circle pulsing", seconds: "4", size: "1280x720" })],
    ]],
  ],
};

// NEW services
const NEW = {
  "image-editing-manipulation": [{
    name: "Image to SVG (arrow-1.1)", kind: "model", provider: "StableStudio", providerId: "stablestudio",
    description: "Convert an existing raster image into clean SVG vectors via StableStudio's arrow-1.1 model (x402, no API key).",
    tags: ["image-to-svg", "vectorize", "stablestudio", "x402"], modality: { input: ["image"], output: ["image"] },
    backends: [
      { url: `${BASE}/arrow-1.1/vectorize`, method: "POST", amount: 0.15, status: "active" },
      { url: `${BASE}/arrow-1.1-max/vectorize`, method: "POST", amount: 0.20, status: "active" },
    ],
    usage: ssUsage(`${BASE}/arrow-1.1/vectorize`, "$0.15 (arrow-1.1) / $0.20 (arrow-1.1-max)", { image: "<blobUrl>", target_size: 1024, auto_crop: false }, UPLOAD_NOTE),
    status: "active",
  }],
};

const affected = new Set();
let added = 0;

for (const [sub, entries] of Object.entries(ADD)) {
  const p = path.join(CUR, `${sub}.json`);
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const [entryName, routes] of entries) {
    const entry = cur.entries.find((e) => e.name === entryName);
    if (!entry) { console.warn(`  ! ${sub}: entry "${entryName}" not found — skip`); continue; }
    entry.backends ||= [];
    const have = new Set(entry.backends.filter((b) => typeof b === "object" && b.url).map((b) => b.url));
    for (const [url, amount, usage] of routes) {
      if (have.has(url)) continue;
      entry.backends.push({ url, method: "POST", amount, status: "active" });
      // attach a StableStudio usage block if the entry has none yet (don't clobber a live-verified one)
      if (!entry.usage || entry.usage.status === "untested") entry.usage = usage;
      added++; affected.add(sub);
      console.log(`  + ${entryName}: ${url} ($${amount})`);
    }
  }
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

for (const [sub, newEntries] of Object.entries(NEW)) {
  const p = path.join(CUR, `${sub}.json`);
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const ne of newEntries) {
    if (cur.entries.some((e) => e.name === ne.name)) { console.log(`  = ${ne.name} already present`); continue; }
    cur.entries.push(ne); added++; affected.add(sub);
    console.log(`  + NEW service: ${ne.name} (${ne.backends.length} backends)`);
  }
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

console.log(`\nAdded ${added} StableStudio backend(s)/service(s). Now rebuild: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);
