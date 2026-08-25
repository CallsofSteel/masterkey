/**
 * next-batch.mjs — select the next N untested endpoints and enrich each with its full backend spec.
 *
 * Deterministic batch selection from qa-checklist.json (status:"todo", in checklist order), joined with
 * the backend's inputSchema / outputSchema / instructions / payment.accepts / modelParam / async hints
 * from data/registry/by-subcat/*.json — so the QA workflow agent has everything it needs to build a
 * minimal valid call without re-reading files.
 *
 * Usage:  node scripts/registry/next-batch.mjs [--n=5] [--ids=svc#0,svc#3]
 *   --n     how many todo endpoints to take (default 5)
 *   --ids   explicit comma-separated endpoint keys to select instead of "next N todo"
 *
 * Prints a single JSON object: { count, endpoints: [ {key, ...spec} ] } to stdout.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const N = args.n ? Number(args.n) : 5;
const explicitIds = args.ids ? String(args.ids).split(",").map((s) => s.trim()).filter(Boolean) : null;

const checklist = JSON.parse(fs.readFileSync(path.join(ROOT, "data/registry/qa-checklist.json"), "utf8"));

let picked;
if (explicitIds) {
  const byKey = new Map(checklist.endpoints.map((e) => [e.key, e]));
  picked = explicitIds.map((id) => byKey.get(id)).filter(Boolean);
} else {
  picked = checklist.endpoints.filter((e) => e.status === "todo").slice(0, N);
}

// cache subcat files
const subcatCache = new Map();
function loadSubcat(sub) {
  if (!subcatCache.has(sub)) {
    const p = path.join(ROOT, "data/registry/by-subcat", `${sub}.json`);
    subcatCache.set(sub, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []);
  }
  return subcatCache.get(sub);
}

const endpoints = picked.map((row) => {
  const [serviceId, idxStr] = row.key.split("#");
  const idx = Number(idxStr);
  const services = loadSubcat(row.subcategory);
  const svc = services.find((s) => s.id === serviceId);
  const backend = svc?.backends?.[idx] ?? null;

  return {
    key: row.key,
    serviceId,
    backendIndex: idx,
    name: svc?.name ?? row.name,
    kind: row.kind,
    category: row.category,
    subcategory: row.subcategory,
    description: svc?.description ?? null,
    provider: backend?.provider ?? row.provider,
    url: backend?.url ?? row.url,
    method: backend?.method ?? row.method ?? "GET",
    authMode: backend?.authMode ?? row.authMode,
    priceDisplay: backend?.price?.display ?? row.priceDisplay,
    priceAmount: backend?.price?.amount ?? row.priceAmount,
    modelParam: backend?.modelParam ?? null,
    outward: row.outward,
    inputSchema: backend?.inputSchema ?? null,
    outputSchema: backend?.outputSchema ?? null,
    instructions: backend?.instructions ?? null,
    paymentAccepts: backend?.payment?.accepts ?? null,
    async: backend?.async ?? svc?.operations?.[idx]?.async ?? null,
    managedResource: svc?.managedResource ?? null,
    existingUsage: svc?.usage ?? null,
    probe: backend?.probe ?? null,
  };
});

process.stdout.write(JSON.stringify({ count: endpoints.length, endpoints }, null, 2));
