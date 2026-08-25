/**
 * qa-pay.mts — the money-safe Sponge payment primitive for Registry QA.
 *
 * Wraps the project's battle-tested `payProvider()` (src/lib/wallet.ts) — which IS the Sponge wallet
 * (@paysponge/sdk) — so every QA paid call gets:
 *   • a HARD per-call ceiling (default $6): the x402 402 quote is pre-flighted and the call is REFUSED
 *     before any money moves if even the cheapest quote exceeds the cap (PaymentExceededError). We never
 *     trust an LLM to "remember to check the price" — the ceiling is deterministic.
 *   • full settlement fidelity: real debited `costUsd` (not the quote), real on-chain `txHash`
 *     (decoded from X-Payment-Response), `confirmed`, `network` — the fields the registry must record.
 *   • every protocol the registry can contain: x402 v1 AND v2, MPP, SIWX-only reads, pay+SIWX.
 *
 * It is a thin CLI: read args → payProvider → print ONE JSON line to stdout (machine-readable for the
 * QA workflow). Nothing is paid unless the quote is within the cap. Secrets load from .env.local and
 * are never printed. (.mts so tsx loads the whole graph as ESM — the SDK is ESM-only.)
 *
 * Workflows run the BUNDLED artifact `dist/qa-pay.mjs`, NOT this source. After editing this file OR any
 * module it pulls in (src/lib/wallet.ts, src/lib/siwx.ts), you MUST rebuild or the change won't ship:
 *   npx esbuild scripts/registry/qa-pay.mts --bundle --platform=node --format=esm --target=node22 \
 *     --packages=external --outfile=scripts/registry/dist/qa-pay.mjs
 * (node_modules stay external — resolved at runtime from the project root.)
 *
 * Usage:
 *   npx tsx scripts/registry/qa-pay.mts --url=<url> [--method=GET] [--cap=6] [--chain=base]
 *        [--body='{"q":"hi"}' | --body=@/path/to/body.json] [--header='K: V' ...]
 *        [--siwx] [--save=<artifactPath>] [--label=<id>]
 *
 * Output (stdout, single JSON object):
 *   { classification, ok, status, paid, confirmed, costUsd, quoteUsd, network, txHash,
 *     contentType, bodyPreview, bodyType, artifactPath?, error?, errorCode? }
 *   classification ∈ "ok-paid" | "ok-free" | "over-cap" | "wallet-error" | "http-error" | "exception"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load secrets from .env.local (and .env) BEFORE importing wallet.ts (which reads SPONGE_* on connect).
// Walk up from cwd then the script dir until we find a project root holding .env.local / package.json —
// robust whether run via tsx (source) or as a bundled .mjs relocated under dist/.
function findRoot(): string {
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, ".env.local")) || fs.existsSync(path.join(dir, "package.json"))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return process.cwd();
}
const ROOT = findRoot();
for (const f of [".env.local", ".env"]) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) dotenv.config({ path: p, quiet: true });
}

import { payProvider, PaymentExceededError, WalletPaymentError } from "../../src/lib/wallet";

type Args = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  const headers: string[] = [];
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

function asString(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function readBody(spec: string | undefined): unknown {
  if (spec == null) return undefined;
  let text = spec;
  if (spec.startsWith("@")) text = fs.readFileSync(spec.slice(1), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text; // allow raw string bodies
  }
}

function parseHeaders(spec: string[] | undefined): Record<string, string> | undefined {
  if (!spec || !spec.length) return undefined;
  const h: Record<string, string> = {};
  for (const line of spec) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(h).length ? h : undefined;
}

/** A compact, safe-to-log preview of the response body + a note on its real shape/size. */
function previewBody(body: unknown): { bodyPreview: unknown; bodyType: string; bodyBytes: number } {
  if (body == null) return { bodyPreview: null, bodyType: "null", bodyBytes: 0 };
  if (typeof body === "string") {
    const bytes = Buffer.byteLength(body, "utf8");
    const looksB64 = body.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(body.slice(0, 256));
    const isDataUrl = body.startsWith("data:");
    if (isDataUrl || looksB64) {
      return { bodyPreview: `<binary/base64 string, ${bytes} bytes, starts: ${body.slice(0, 48)}…>`, bodyType: "binary-string", bodyBytes: bytes };
    }
    return { bodyPreview: body.length > 2000 ? body.slice(0, 2000) + "…[truncated]" : body, bodyType: "string", bodyBytes: bytes };
  }
  const seen = new WeakSet<object>();
  const trimmed = JSON.parse(
    JSON.stringify(body, (_k, v) => {
      if (typeof v === "string" && v.length > 600) return v.slice(0, 600) + `…[+${v.length - 600} chars]`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }),
  );
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  return { bodyPreview: trimmed, bodyType: Array.isArray(body) ? "array" : "object", bodyBytes: bytes };
}

function extractQuoteUsd(msg: string): number | undefined {
  const m = msg.match(/price\s+([\d.]+)\s+USD/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Cross-agent SPRINT BUDGET guard. When a bulk sweep runs many qa-pay agents in parallel, the per-call
 * `--cap` is not enough — collectively they could spend far more than the sprint allows. This sums every
 * settled charge already recorded in qa-spend-log.jsonl whose label starts with QA_SPRINT_PREFIX and
 * returns how much of QA_SPRINT_CEILING is left. The caller then clamps maxValueUsd to the remainder, so
 * payProvider refuses (atomically, before money moves) any call that would push the sprint over budget.
 * Best-effort: a small read-race overshoot is possible under high concurrency, bounded by ~concurrency ×
 * per-call cap; with sub-cent/few-cent Orbis calls that is negligible.
 */
function sprintSpentSoFar(prefix: string): number {
  try {
    const logPath = path.join(ROOT, "data/registry/qa-spend-log.jsonl");
    if (!fs.existsSync(logPath)) return 0;
    let sum = 0;
    for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.label === "string" && r.label.startsWith(prefix) && typeof r.costUsd === "number") sum += r.costUsd;
      } catch {
        /* skip malformed line */
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
  const headers = parseHeaders(args.header as string[] | undefined);
  const siwxHint = args.siwx ? "siwx" : undefined;
  const savePath = asString(args.save);

  const out: Record<string, unknown> = { url, method, capUsd: cap, label: asString(args.label) };

  // SPRINT BUDGET GUARD: enforce a cross-agent total ceiling. Activated by env QA_SPRINT_CEILING (USD)
  // + QA_SPRINT_PREFIX (which spend-log labels count toward this sprint). Refuses BEFORE any money moves
  // once the sprint is exhausted, and clamps this call's effective cap to whatever budget remains.
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
    cap = Math.min(cap, remaining); // clamp so a single call can never push the sprint over budget
    out.capUsd = cap;
  }

  try {
    // requireChallenge: never pay an endpoint whose unpaid probe didn't present a 402/SIWX/free-2xx —
    // implements "confirm 402, then pay" and stops money leaking into dead slugs (e.g. orbis 404s).
    const r = await payProvider({ url, method, headers, body, maxValueUsd: cap, preferredChain: chain, siwxHint, requireChallenge: true });
    const { bodyPreview, bodyType, bodyBytes } = previewBody(r.body);

    let artifactPath: string | undefined;
    if (savePath) {
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      const raw = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
      fs.writeFileSync(savePath, raw);
      artifactPath = savePath;
    }

    // Authoritative spend log: append EVERY settled charge so batch accounting never relies on an
    // agent self-reporting its costs (agents under-count exploratory calls). One JSON line per charge.
    if (r.paid && r.costUsd > 0) {
      try {
        const logPath = path.join(ROOT, "data/registry/qa-spend-log.jsonl");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(
          logPath,
          JSON.stringify({ ts: new Date().toISOString(), label: asString(args.label) ?? null, url, method, costUsd: r.costUsd, confirmed: r.confirmed, txHash: r.txHash ?? null, network: r.network, status: r.status }) + "\n",
        );
      } catch {
        /* logging must never break a paid call's result */
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
      artifactPath,
    });
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0);
  } catch (e) {
    if (e instanceof PaymentExceededError) {
      // If the cap was clamped below the caller's real cap by the sprint guard, the refusal is a budget
      // stop (the endpoint may be affordable) — label it so accounting doesn't mistake it for over-cap.
      const quote = extractQuoteUsd(e.message);
      const budgetClamped = cap < origCap && (quote == null || quote <= origCap);
      Object.assign(out, { classification: budgetClamped ? "budget-exhausted" : "over-cap", paid: false, quoteUsd: quote, error: e.message });
    } else if (e instanceof WalletPaymentError) {
      Object.assign(out, { classification: "wallet-error", paid: false, errorCode: e.code ?? null, error: e.message });
    } else {
      Object.assign(out, { classification: "exception", paid: false, error: e instanceof Error ? e.message : String(e) });
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0); // exit 0 so the workflow reads the JSON verdict; classification carries the failure
  }
}

void main();
