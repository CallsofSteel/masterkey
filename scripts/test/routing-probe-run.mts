// routing-probe-run.mts — LIVE end-to-end verification for BUNDLE_STUDIO_SPEC §9.3.
// Drives the real durable path (same calls POST /api/runs makes: createRun -> getRuntime().start) with the
// curated `routing-probe` bundle, then asserts from the persisted transcript that the brain actually
// FOLLOWED the compiled branch + loop routing.
//
// Requires: `npm run dev` (MASTERKEY_ORIGIN) + `npx trigger.dev@latest dev` (the worker), and MONGODB_URI.
// Costs $0 USDC — every step calls a FREE registry service (commodity/fx/crypto price).
//
//   npx tsx --env-file=.env.local scripts/test/routing-probe-run.mts <A|B> "BTC-USD, ETH-USD, SOL-USD"
import { createRun, getRun, getSteps } from "../../src/lib/chat/db";
import { getRuntime } from "../../src/lib/runtime";
import { compileRecipe, renderRecipeForBrain } from "../../src/lib/studio/compile";
import { getDb } from "../../src/lib/db";
// Test FIXTURE, deliberately not in data/bundles/ — everything there shows in the user-facing "/" menu
// and Curated tab, and a self-test bundle is not a product feature.
import probeBundle from "./fixtures/routing-probe.json" with { type: "json" };

const mode = (process.argv[2] || "A").toUpperCase();
const tickers = process.argv[3] || "BTC-USD, ETH-USD, SOL-USD";
const expectedItems = tickers.split(",").map((t) => t.trim()).filter(Boolean);

// Any real user — the run is $0 and writes only its own transcript.
const db = await getDb();
const user = await db.collection("users").findOne({});
if (!user) throw new Error("no user in Mongo to attribute the run to");
const userId = String(user._id);

const bundleRecipe = renderRecipeForBrain(compileRecipe(probeBundle as never));

const goal = `/routing-probe\n\nInputs for this run:\n- mode: ${mode}\n- tickers: ${tickers}`;
const run = await createRun({ userId, goal });
const runId = run._id;
console.log(`▶ run ${runId}  (mode=${mode}, tickers=${expectedItems.join(", ")})`);

const { engineRunId } = await getRuntime().start({ runId, userId, goal, bundleRecipe, assetUrls: [] });
if (!engineRunId) throw new Error("engine did not start — is `npx trigger.dev dev` running?");

// ---- wait for terminal ----
const TERMINAL = new Set(["complete", "failed", "canceled", "capped", "needs_approval"]);
const deadline = Date.now() + 8 * 60_000;
let status = "queued";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const doc = await getRun(runId);
  status = doc?.status ?? "unknown";
  process.stdout.write(`\r   status: ${status}        `);
  if (TERMINAL.has(status)) break;
}
console.log(`\n   final status: ${status}`);

// ---- assert routing from the transcript ----
// Ground truth = the per-call `result` steps. (A `tool_call` step holds a whole assistant turn, which may
// batch several tool_use blocks, so it is NOT a per-call counter — `result` is one row per settled call.)
const steps = await getSteps(runId);
const calls = steps
  .filter((s) => s.kind === "result")
  .map((s) => (s.data ?? {}) as Record<string, unknown>)
  .filter((d) => d.toolName === "run_service" && !d.isError)
  .map((d) => (d.structured ?? {}) as Record<string, unknown>);

const used = calls.map((c) => String(c.serviceId ?? "")).filter(Boolean);
const symbolsFor = (id: string) =>
  calls
    .filter((c) => c.serviceId === id)
    .map((c) => String(((c.raw ?? {}) as Record<string, unknown>).symbol ?? ""))
    .filter(Boolean);
const text = steps.map((s) => JSON.stringify(s.data ?? {})).join("\n");

const count = (id: string) => used.filter((u) => u === id).length;
const taken = mode === "A" ? "commodity-price" : "fx-price";
const notTaken = mode === "A" ? "fx-price" : "commodity-price";

const results: Array<[string, boolean, string]> = [
  [`took the ${mode} branch (${taken} called)`, count(taken) >= 1, `count=${count(taken)}`],
  [`did NOT take the other branch (${notTaken} absent)`, count(notTaken) === 0, `count=${count(notTaken)}`],
  [`looped exactly ${expectedItems.length}× (crypto-price)`, count("crypto-price") === expectedItems.length, `count=${count("crypto-price")}`],
  // One call PER item — catches the classic shortcut of batching the collection into a single call.
  [`loop priced each ticker exactly once`,
    JSON.stringify([...symbolsFor("crypto-price")].sort()) === JSON.stringify([...expectedItems].sort()),
    `symbols=${JSON.stringify(symbolsFor("crypto-price"))}`],
  [`printed BRANCH=${mode}`, text.includes(`BRANCH=${mode}`), ""],
  [`did not print BRANCH=${mode === "A" ? "B" : "A"}`, !text.includes(`BRANCH=${mode === "A" ? "B" : "A"}`), ""],
];

console.log(`\n   service calls: ${JSON.stringify(used)}`);
console.log("");
let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`   ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}
const cost = (await getRun(runId))?.providerCostUsd ?? 0;
console.log(`\n   provider cost: $${cost}  ${cost === 0 ? "(free ✓)" : "(EXPECTED $0)"}`);
console.log(`\nrouting-probe(${mode}): ${results.length - failed} passed, ${failed} failed.`);
process.exit(failed || status !== "complete" ? 1 : 0);
