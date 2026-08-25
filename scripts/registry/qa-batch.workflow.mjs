export const meta = {
  name: "registry-qa-batch",
  description: "Pay-test, document, and blind-verify a batch of x402 registry endpoints (money-safe)",
  phases: [
    { title: "Phase A — pay & document" },
    { title: "Phase B — blind verify" },
  ],
};

// args = { contact:{email,phone,address,name}, projectRoot?, specPath, endpoints:[{key,serviceId,name,url,method,priceDisplay,subcategory,outward}] }
// endpoints carries only LIGHT fields (labels + Phase B + outward routing). The HEAVY spec for each
// endpoint (inputSchema, outputSchema, instructions, payment.accepts, async, managedResource, existing
// usage, description) lives in the file at `specPath`; each Phase A agent reads its own object by key.
const contact = (args && args.contact) || {};
const endpoints = (args && args.endpoints) || [];
// Workflow agents run with cwd = harness primary dir, NOT the project dir — so every path the agents
// use must be ABSOLUTE. (qa-pay itself finds .env.local via its own __dirname walk-up regardless.)
const ROOT = (args && args.projectRoot) || process.cwd();
const PAY = `${ROOT}/scripts/registry/dist/qa-pay.mjs`;
const SPEC_PATH = (args && args.specPath) || `${ROOT}/data/registry/qa-batch-current.json`;
const CAP = (args && args.cap) || 10;

if (!endpoints.length) {
  log("No endpoints passed in args.endpoints — nothing to do.");
  return { results: [] };
}

log(`Batch: ${endpoints.length} endpoints → ${endpoints.map((e) => e.key).join(", ")}`);

// ---- structured-output schemas ----------------------------------------------------------------

const PHASE_A_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "key", "serviceId", "classification", "paid", "costUsd", "httpStatus",
    "needsVerification", "outward", "usageStatus", "resultPull", "auth",
    "callShape", "inputExample", "outputShape", "quirks", "needsApproval", "guide", "costObservedUsd", "notes",
  ],
  properties: {
    key: { type: "string" },
    serviceId: { type: "string" },
    classification: { type: "string", enum: ["verified", "verified-with-quirks", "broken", "over-cap", "needs-input", "free-ok"] },
    paid: { type: "boolean" },
    costUsd: { type: "number" },
    confirmed: { type: "boolean" },
    txHash: { type: ["string", "null"] },
    network: { type: "string" },
    httpStatus: { type: "number" },
    needsVerification: { type: "boolean" },
    outward: { type: "boolean" },
    usageStatus: { type: "string", enum: ["verified", "broken", "untested"] },
    resultPull: { type: "string", enum: ["sync", "poll", "siwx", "none"] },
    auth: { type: "string", enum: ["none", "siwx"] },
    callShape: { type: "string" },
    inputExample: { type: "object", additionalProperties: true },
    outputShape: { type: "string" },
    quirks: { type: "array", items: { type: "string" } },
    needs: { type: "array", items: { type: "string" } },
    needsApproval: { type: "boolean" },
    guide: { type: "string" },
    costObservedUsd: { type: "number" },
    notes: { type: "string" },
  },
};

const PHASE_B_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "verdict", "paidAgain", "costUsd", "stepsTaken", "responseSummary", "whatWasMissing"],
  properties: {
    key: { type: "string" },
    verdict: { type: "string", enum: ["PASS", "FAIL", "SKIP"] },
    paidAgain: { type: "boolean" },
    costUsd: { type: "number" },
    stepsTaken: { type: "string" },
    responseSummary: { type: "string" },
    whatWasMissing: { type: "string" },
  },
};

// ---- prompt builders --------------------------------------------------------------------------

function phaseAPrompt(spec) {
  const contactBlock = spec.outward
    ? `\n### OUTWARD/IRREVERSIBLE ENDPOINT\nThis endpoint performs a real-world action (send/charge/publish/ship). Use ONLY this real contact as the destination so the user can verify receipt:\n- email: ${contact.email || "(none provided)"}\n- phone: ${contact.phone || "(none provided)"}\n- name: ${contact.name || "(none provided)"}\n- address: ${contact.address || "(none provided)"}\nDo NOT invent recipients. If the endpoint needs a destination you don't have, classify "needs-input".\n`
    : "";

  return `You are the Phase A tester for a money-real x402 registry QA run. You will PAY REAL USDC. Be precise and money-safe.

## The endpoint under test
- key: ${spec.key}
- service: ${spec.name} (${spec.serviceId}), kind=${spec.kind || "?"}
- subcat: ${spec.subcategory}
- CALL: ${spec.method} ${spec.url}
- price (registry surface): ${spec.priceDisplay}
${contactBlock}
## FIRST STEP — read your full machine spec
Run: \`cat ${SPEC_PATH}\` and find the object in \`.endpoints[]\` whose \`key\` === "${spec.key}". It has the
full inputSchema, outputSchema, instructions, payment.accepts, async hint, managedResource, existingUsage,
and description. Use it to build a correct minimal call. (The light fields above are just a summary.)

## How you pay (ONLY this tool — it is money-safe, $10 hard ceiling, full settlement capture)
IMPORTANT: your shell cwd is NOT the project dir. Use these ABSOLUTE paths verbatim.
Run via Bash:
\`node ${PAY} --url='<url>' --method='<METHOD>' --cap=${CAP} [--body=@/tmp/qa-${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.json] [--siwx] [--save=${ROOT}/data/registry/qa-artifacts/${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.bin] --label='${spec.key}'\`
- For POST/PUT/PATCH bodies: write the JSON to a temp file first (Write to /tmp/qa-${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.json), then pass --body=@<that path>. Avoids shell-quoting bugs.
- The tool prints ONE JSON line: { classification, ok, status, paid, confirmed, costUsd, quoteUsd, network, txHash, contentType, bodyType, bodyBytes, bodyPreview, error }.
- classification "over-cap" means the quote exceeded $10 and NOTHING was paid → report it, don't retry.

## MONEY-SAFETY RULES (mandatory)
1. IDEMPOTENCY: First Bash: \`cat ${ROOT}/data/registry/qa-results/${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.a.json 2>/dev/null\`. If it exists AND shows paid:true (or a terminal classification), REUSE it — do NOT pay again.
2. UNRESOLVED URL TEMPLATES: if the url contains a placeholder segment you cannot fill from schema/instructions/managedResource (e.g. \`/:endpoint\`, \`/{inbox_id}\`, \`/:call_id\`), do NOT pay — you would lose money to a 404. Classify "needs-input", explain which placeholder is unresolved. (Path params you CAN fill, like :zip→a real zip, :address→a real token address, you SHOULD fill.)
3. MINIMAL INPUT: build the smallest valid input. Chat/LLM → {"messages":[{"role":"user","content":"hello"}]} or the schema's shape; TTS → short text "hello how are you?"; moderation/classify → a short sample string; image/video gen → a tiny prompt like "a red circle". Don't send essays.
4. EMPTY SCHEMA: if inputSchema is empty/missing, infer the body from the service name + description (e.g. content-moderation → {"text":"..."}). Try the most likely field name; if it 422s with a useful hint, adjust ONCE and retry (you may pay twice max). If still unclear, classify "needs-input".
5. SIWX: if authMode is "siwx" OR the result error mentions sign-in/siwx, re-run with --siwx.
6. ASYNC: if the paid response looks like a queued job (has job id + status pending/processing), follow the async hint / poll the status URL a few times (cheap/free) until done or ~6 polls. Document the polling in quirks + set resultPull:"poll".
7. ORBIS PROXIES (url contains orbisapi.com/proxy/): KNOWN charge-then-404 pattern. The unpaid pre-flight will show 402 (looks payable) — that does NOT mean it works. Pay exactly ONCE. If the post-payment response is 404 / 4xx / HTML error page / refund / "API_NOT_FOUND", classify "broken" IMMEDIATELY — do NOT retry, do NOT try alternate bodies or paths (the slug/route is dead; retries only lose more money).

## Your job
1. Pay-test the endpoint following the rules above (one successful paid call is the goal; ≤2 paid attempts).
2. Classify:
   - "verified": paid, worked, no special handling needed (plain sync).
   - "verified-with-quirks": worked but needed non-obvious handling (template fill, odd field name, async poll, siwx, weird output location).
   - "free-ok": returned 2xx with no payment required (free endpoint) and works.
   - "broken": paid/attempted but endpoint is dead/errors (404/5xx/refund/garbage) — money may be lost; note it.
   - "over-cap": quote > $6, nothing paid.
   - "needs-input": cannot test without info you don't have (unresolved template, missing recipient/resource).
3. Write your raw result (Write tool) to \`${ROOT}/data/registry/qa-results/${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.a.json\` (the qa-pay JSON + your classification) so the run is crash-safe.
4. Draft a precise usage block for the registry. Fields:
   - usageStatus: "verified" (worked) | "broken" | "untested" (couldn't test).
   - resultPull: "sync" | "poll" | "siwx" | "none".
   - auth: "none" | "siwx".
   - callShape: exact, e.g. "POST ${spec.url} with JSON body {text}".
   - inputExample: the REAL body object that produced a result (or best-known if untested).
   - outputShape: where the useful result is in the response (dot path), e.g. "body.flagged, body.categories[]".
   - quirks: array of EXACT gotchas a fresh agent must know (empty array if none).
   - needsApproval: true for outward/irreversible.
   - guide: 2-5 plain sentences telling an agent exactly how to call it and read the result.
   - costObservedUsd: the real costUsd from qa-pay (0 if free/not paid).
5. Set needsVerification=true if classification is "verified-with-quirks" OR outward OR resultPull is poll/siwx OR there's a sessionFlow/managedResource. Otherwise false (plain verified / free-ok / broken / over-cap / needs-input don't need blind re-verification).

Return the structured object. Your final answer IS the data (no prose).`;
}

function phaseBPrompt(spec, a) {
  // BLIND: the verifier sees ONLY the drafted doc — not the full spec, not Phase A's reasoning.
  return `You are a BLIND verifier. Using ONLY the documentation below, make a real paid call to this service and judge whether the doc was sufficient. You have NO other context. Spend cap $6.

## Documentation under test (this is ALL you get)
- What it does: ${spec.name} — ${a.guide}
- Call: ${a.callShape}
- Cost: ~$${a.costObservedUsd} per call
- Input example:
\`\`\`json
${JSON.stringify(a.inputExample, null, 2)}
\`\`\`
- Output: ${a.outputShape}
- Quirks: ${(a.quirks && a.quirks.length) ? a.quirks.join("; ") : "(none stated)"}
- Auth: ${a.auth}${a.outward ? "\n- NOTE: outward/irreversible — this WILL send/charge for real. Use destination email " + (contact.email || "(none)") + " / phone " + (contact.phone || "(none)") + " only." : ""}

## How to pay (money-safe, $6 ceiling) — use ABSOLUTE paths (your cwd is not the project dir)
\`node ${PAY} --url='<url>' --method='<METHOD>' --cap=${CAP} [--body=@/tmp/qb-${spec.key.replace(/[^a-zA-Z0-9]/g, "_")}.json] [--siwx] --label='verify-${spec.key}'\`
Write any JSON body to a temp file and pass --body=@path.

## Your job
1. Reconstruct the call from the doc ALONE and make ONE real paid call (≤2 if the first reveals a clear fixable issue).
2. Verdict:
   - PASS: you made a successful paid call using only the doc.
   - FAIL: the doc was insufficient — you had to guess, it was wrong, or you got stuck.
3. Be specific in whatWasMissing: which field/value/step the doc failed to convey.

Return the structured object (key="${spec.key}"). Your final answer IS the data.`;
}

// ---- run: pipeline (Phase A → conditional Phase B), per-endpoint, no barrier --------------------

const results = await pipeline(
  endpoints,
  (spec) => agent(phaseAPrompt(spec), { label: `A:${spec.key}`, phase: "Phase A — pay & document", schema: PHASE_A_SCHEMA }),
  (a, spec) => {
    if (!a) return null;
    if (!a.needsVerification) return { phaseA: a, phaseB: { key: spec.key, verdict: "SKIP", paidAgain: false, costUsd: 0, stepsTaken: "", responseSummary: "no blind verification needed", whatWasMissing: "" } };
    return agent(phaseBPrompt(spec, a), { label: `B:${spec.key}`, phase: "Phase B — blind verify", schema: PHASE_B_SCHEMA })
      .then((b) => ({ phaseA: a, phaseB: b }))
      .catch(() => ({ phaseA: a, phaseB: { key: spec.key, verdict: "SKIP", paidAgain: false, costUsd: 0, stepsTaken: "", responseSummary: "phase B errored", whatWasMissing: "" } }));
  },
);

const clean = results.filter(Boolean);
log(`Done. ${clean.length}/${endpoints.length} endpoints processed.`);
return { results: clean };
