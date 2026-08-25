// Diff the original mock taxonomy (src/data/*.ts service names) against the built registry
// (data/registry/by-subcat/*.json) and emit a "missed" checklist of brand-name search targets.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../..");
const DATA = join(ROOT, "src/data");
const BYSUB = join(ROOT, "data/registry/by-subcat");

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// 1) Build registry coverage blob (entry names + aka + providers + backend providers), normalized.
let blob = "";
for (const f of readdirSync(BYSUB).filter((f) => f.endsWith(".json"))) {
  for (const s of JSON.parse(readFileSync(join(BYSUB, f), "utf8"))) {
    blob += " " + norm(s.name) + " " + norm(s.provider);
    for (const a of s.aka || []) blob += " " + norm(a);
    for (const b of s.backends || []) blob += " " + norm(b.provider);
  }
}

// 2) Parse mock files: track category (indent<=3), subcategory (indent 5-8), service (indent>=9).
const STOP = new Set(["the", "api", "ai", "and", "cloud", "data", "open", "source", "via", "inc", "io", "app", "labs", "platform", "service", "services"]);
const out = {}; // "Category / Subcat" -> [serviceNames]
for (const f of readdirSync(DATA).filter((f) => f.endsWith(".ts") && !["index.ts", "types.ts"].includes(f))) {
  const lines = readFileSync(join(DATA, f), "utf8").split("\n");
  let cat = "", sub = "";
  for (const line of lines) {
    const m = line.match(/^(\s*)name:\s*"([^"]+)"/);
    if (!m) continue;
    const indent = m[1].length, name = m[2];
    if (indent <= 3) cat = name;
    else if (indent <= 8) sub = name;
    else { (out[`${cat} / ${sub}`] ||= []).push(name); }
  }
}

// 3) A mock service is "covered" if any meaningful token of its name appears in the registry blob.
function covered(name) {
  const variants = name.split(/[\/,(){}\[\]]/).map((v) => v.trim()).filter(Boolean);
  for (const v of variants) {
    const n = norm(v);
    if (n.length >= 5 && blob.includes(n)) return true; // whole-name-ish match
    for (const w of v.split(/\s+/)) { const t = norm(w); if (t.length >= 4 && !STOP.has(t) && blob.includes(t)) return true; }
  }
  return false;
}

let total = 0, missed = 0;
const sections = [];
for (const [key, names] of Object.entries(out)) {
  const miss = [...new Set(names)].filter((n) => { total++; const c = covered(n); if (!c) missed++; return !c; });
  if (miss.length) sections.push({ key, miss });
}

let md = `# Missed — brand-name search targets\n\n`;
md += `> Auto-diff of the original mock taxonomy (\`src/data/*.ts\`, ${total} service names) vs the built registry (\`data/registry/by-subcat/\`). Listed below are mock services whose brand/name does **not** appear in the registry yet — i.e. candidates to search for by name. NOTE: many are classic SaaS (OpenAI, Stripe, Cloudflare…) that are **not** x402-native and will prune; the value is the recognizable AI/agent brands we may have missed.\n\n`;
md += `**Coverage: ${total - missed}/${total} mock names represented · ${missed} not yet found.**\n\n`;
for (const { key, miss } of sections) {
  md += `## ${key}  (${miss.length})\n`;
  for (const n of miss) md += `- [ ] search "${n}"\n`;
  md += `\n`;
}
writeFileSync(join(ROOT, "missed.md"), md);
console.log(`mock service names: ${total} | not-in-registry: ${missed} | sections: ${sections.length}`);
console.log("written: missed.md");
