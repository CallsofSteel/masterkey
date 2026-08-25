export const meta = {
  name: "orbis-sprint",
  description: "Pay-test the fresh Orbis catalog (charge-then-404 aware, $25 sprint budget, money-safe)",
  phases: [
    { title: "Phase A — pay & document" },
    { title: "Phase B — blind verify survivors" },
  ],
};

// args = { offset?, limit, file?, cap?, projectRoot?, sprintCeiling?, sprintPrefix? }
// The workflow sandbox has NO fs, and inlining thousands of specs (or having an agent regenerate exact
// URLs) is fragile + risks paying the wrong endpoint. So we pass only offset+limit: the pipeline iterates
// over plain INDICES, and each agent extracts its ONE spec from the endpoints file by index via a node
// one-liner (only that single ~150-byte object enters the agent's context — file size is irrelevant, and
// the url/key are read VERBATIM from disk, never transcribed).
const ROOT = (args && args.projectRoot) || process.cwd();
const FILE = (args && args.file) || `${ROOT}/data/registry/orbis-sprint-endpoints.json`;
const OFFSET = (args && args.offset) || 0;
const LIMIT = (args && args.limit) || 0;
const PAY = `${ROOT}/scripts/registry/dist/qa-pay.mjs`;
const CAP = (args && args.cap) || 0.8;
const CEIL = (args && args.sprintCeiling) || 25;
const PREFIX = (args && args.sprintPrefix) || "orbissprint";
const RESULTS = `${ROOT}/data/registry/qa-results`;

if (!LIMIT) {
  log("No limit passed in args.limit — nothing to do.");
  return { results: [] };
}
const indices = Array.from({ length: LIMIT }, (_, i) => OFFSET + i);
log(`Orbis sprint: indices ${OFFSET}..${OFFSET + LIMIT - 1} (${LIMIT}) | per-call cap $${CAP} | sprint ceiling $${CEIL}`);

// Extract command: prints ONLY the one endpoint object for index i (file never enters context).
const extract = (i) =>
  `node -e 'const a=require("${FILE}").endpoints[${i}]; if(!a){process.stdout.write("__NONE__")}else{process.stdout.write(JSON.stringify(a))}'`;

const PHASE_A_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "key", "slug", "url", "classification", "paid", "costUsd", "httpStatus",
    "usageStatus", "resultPull", "auth", "callShape", "inputExample",
    "outputShape", "quirks", "guide", "costObservedUsd", "needsVerification", "notes",
  ],
  properties: {
    key: { type: "string" },
    slug: { type: "string" },
    url: { type: "string" },
    // verified=worked plain | verified-with-quirks=worked w/ non-obvious handling | free-ok=2xx no pay
    // | broken=dead/charge-then-4xx/errors | over-cap=quote>cap nothing paid
    // | needs-input=can't test w/o info | budget-skip=sprint budget exhausted, untested
    classification: { type: "string", enum: ["verified", "verified-with-quirks", "free-ok", "broken", "over-cap", "needs-input", "budget-skip"] },
    paid: { type: "boolean" },
    costUsd: { type: "number" },
    confirmed: { type: "boolean" },
    txHash: { type: ["string", "null"] },
    httpStatus: { type: "number" },
    usageStatus: { type: "string", enum: ["verified", "broken", "untested"] },
    resultPull: { type: "string", enum: ["sync", "poll", "siwx", "none"] },
    auth: { type: "string", enum: ["none", "siwx"] },
    callShape: { type: "string" },
    inputExample: { type: "object", additionalProperties: true },
    outputShape: { type: "string" },
    quirks: { type: "array", items: { type: "string" } },
    guide: { type: "string" },
    costObservedUsd: { type: "number" },
    needsVerification: { type: "boolean" },
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

function phaseAPrompt(i) {
  return `You are the Phase A tester for a money-real x402 QA sprint over the Orbis API marketplace. You will PAY REAL USDC. Be precise and money-safe. Your shell cwd is NOT the project dir — use the ABSOLUTE paths below verbatim.

## STEP 0 — load your endpoint spec (index ${i})
Run via Bash:
\`${extract(i)}\`
This prints ONE JSON object: {key, slug, name, url, price, description}. If it prints "__NONE__", there is no endpoint at this index — return a structured result with key="none-${i}", slug="none", url="", classification="needs-input", everything empty/false, notes="no endpoint at index ${i}". Otherwise parse it and use its EXACT url and key for everything below. Let KEY = its key, SAFE = KEY with every non-alphanumeric char replaced by "_".

## STEP 1 — idempotency (never pay twice)
Run: \`cat ${RESULTS}/<SAFE>.a.json 2>/dev/null\`
If it exists AND shows "paid":true OR a terminal classification (broken/verified/verified-with-quirks/free-ok/needs-input/over-cap/budget-skip), REUSE it — do NOT pay again. Return that same data as your structured answer.

## STEP 2 — build the smallest valid body
Orbis proxies expose no per-endpoint schema here. Infer the SMALLEST plausible JSON body from name + description:
- text/nlp/moderation/classify/sentiment/translate/summarize → {"text":"hello world"} (translate: add {"target":"es"})
- chat/llm/completion → {"messages":[{"role":"user","content":"hello"}]}
- image analysis/ocr/vision → {"image_url":"https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg"}
- image/video generation → {"prompt":"a red circle"}
- embeddings → {"input":"hello"}
- url/web/scrape/screenshot/pdf-from-url → {"url":"https://example.com"}
- else → infer the single most likely field from the name; keep it tiny.
Write that JSON to /tmp/qa-<SAFE>.json using the Write tool.

## STEP 3 — pay EXACTLY ONCE (money-safe; per-call cap $${CAP}, sprint ceiling $${CEIL})
Run via Bash (substitute the real url and SAFE):
\`QA_SPRINT_CEILING=${CEIL} QA_SPRINT_PREFIX=${PREFIX} node ${PAY} --url='<url>' --method='POST' --cap=${CAP} --body=@/tmp/qa-<SAFE>.json --label='<KEY>'\`
It prints ONE JSON line: { classification, ok, status, paid, confirmed, costUsd, quoteUsd, network, txHash, bodyPreview, error, sprintRemainingUsd? }.

## MONEY-SAFETY RULES (mandatory)
1. ORBIS CHARGE-THEN-4xx: Orbis proxies frequently accept payment THEN return 404/401/4xx / HTML / "API_NOT_FOUND" / "Invalid API key" / refund. A 402 on pre-flight does NOT mean it works. Pay ONCE. If the post-payment response is 4xx / HTML-error / "API_NOT_FOUND" / "Invalid API key" / garbage → classify "broken" IMMEDIATELY. Do NOT retry, do NOT try alternate bodies/paths — the slug is dead and retries only lose more money.
   EXCEPTION (sub-path pattern): if the paid response is a 200 that returns the API's OWN descriptor (an object with inputSchema / endpoints / a list of sub-routes) instead of a computed result, the real route is a sub-path. You MAY make ONE more paid call to the most likely sub-path (append e.g. /analyze, /score, /classify, /generate from the descriptor's endpoint list) — max 2 paid calls total. If that returns a real result → verified-with-quirks (document the sub-path). If it 4xxs → broken.
2. BUDGET: if qa-pay returns classification "budget-exhausted" (sprint ceiling hit — nothing paid), classify the endpoint "budget-skip", usageStatus "untested", paid false. Do NOT retry. Return immediately.
3. OVER-CAP: if qa-pay returns "over-cap" (quote > $${CAP}, nothing paid) → classify "over-cap". Don't retry.
4. WRONG FIELD: a 422 with a CLEAR field-name hint may justify ONE adjusted retry (max 2 paid total). Otherwise no retry.
5. SIWX: if the error mentions sign-in/siwx, re-run the SAME command with \`--siwx\` appended.
6. ASYNC: if the paid 2xx is a queued job (id + status pending/processing), it's a working endpoint → resultPull "poll", note polling in quirks, classify verified-with-quirks.

## STEP 4 — record (crash-safe)
Write your raw result (the qa-pay JSON line(s) + your classification) with the Write tool to: ${RESULTS}/<SAFE>.a.json

## STEP 5 — classify + draft usage
- key, slug, url: from STEP 0 (EXACT).
- classification: verified | verified-with-quirks | free-ok | broken | over-cap | needs-input | budget-skip
- usageStatus: "verified" (worked) | "broken" | "untested" (over-cap/needs-input/budget-skip)
- resultPull: sync | poll | siwx | none ; auth: none | siwx
- callShape: e.g. "POST <url> with JSON {text}" (include the sub-path if one was needed)
- inputExample: the REAL body object that produced the result ({} if none)
- outputShape: dot path to the useful result, e.g. "body.sentiment, body.score" (empty if broken)
- quirks: EXACT gotchas a fresh agent needs (empty array if none / if broken)
- guide: 1-4 plain sentences on how to call it + read the result. For broken: one line stating it's dead + the exact error.
- costObservedUsd: real total costUsd paid (sum if 2 calls; 0 if nothing paid)
- needsVerification: true ONLY if classification is "verified-with-quirks" OR resultPull is poll/siwx. Else false.
- notes: short free text (e.g. "charge-then-404 API_NOT_FOUND", "worked via /analyze", "sprint-budget-exhausted")

Return the structured object. Your final answer IS the data (no prose).`;
}

function phaseBPrompt(i, a) {
  const safeKey = a.key.replace(/[^a-zA-Z0-9]/g, "_");
  // Label MUST start with PREFIX so the sprint-budget guard counts Phase B spend too (a.key already
  // starts with the prefix; suffixing keeps it inside the budgeted namespace).
  const payCmd = `QA_SPRINT_CEILING=${CEIL} QA_SPRINT_PREFIX=${PREFIX} node ${PAY} --url='${a.url}' --method='POST' --cap=${CAP} --body=@/tmp/qb-${safeKey}.json --label='${a.key}-verify'`;
  return `You are a BLIND verifier. Using ONLY the documentation below, make ONE real paid call and judge whether the doc was sufficient. You have NO other context. Your cwd is not the project dir — use absolute paths.

## Documentation under test (this is ALL you get)
- What it does: ${a.guide}
- Call: ${a.callShape}
- Cost: ~$${a.costObservedUsd} per call
- Input example:
\`\`\`json
${JSON.stringify(a.inputExample, null, 2)}
\`\`\`
- Output: ${a.outputShape}
- Quirks: ${(a.quirks && a.quirks.length) ? a.quirks.join("; ") : "(none stated)"}
- Auth: ${a.auth}

## How to pay (money-safe; per-call cap $${CAP}, sprint ceiling $${CEIL})
Write your JSON body to /tmp/qb-${safeKey}.json (Write tool), then run:
\`${payCmd}\`
(If the doc names a sub-path in callShape, use that exact URL instead of the base.) If qa-pay returns "budget-exhausted", verdict SKIP (note budget). If "siwx" error, append --siwx and retry once.

## Your job
1. Reconstruct the call from the doc ALONE; make ONE real paid call (≤2 only if the first reveals a clear fixable issue).
2. Verdict: PASS (worked using only the doc) | FAIL (doc insufficient/wrong/stuck) | SKIP (budget).
3. whatWasMissing: which field/value/step the doc failed to convey (empty if PASS).

Return the structured object (key="${a.key}"). Your final answer IS the data.`;
}

const results = await pipeline(
  indices,
  (i) => agent(phaseAPrompt(i), { label: `A:#${i}`, phase: "Phase A — pay & document", schema: PHASE_A_SCHEMA }),
  (a, i) => {
    if (!a) return null;
    if (!a.needsVerification) return { phaseA: a, phaseB: { key: a.key, verdict: "SKIP", paidAgain: false, costUsd: 0, stepsTaken: "", responseSummary: "no blind verification needed", whatWasMissing: "" } };
    return agent(phaseBPrompt(i, a), { label: `B:${a.slug}`, phase: "Phase B — blind verify survivors", schema: PHASE_B_SCHEMA })
      .then((b) => ({ phaseA: a, phaseB: b }))
      .catch(() => ({ phaseA: a, phaseB: { key: a.key, verdict: "SKIP", paidAgain: false, costUsd: 0, stepsTaken: "", responseSummary: "phase B errored", whatWasMissing: "" } }));
  },
);

const clean = results.filter(Boolean);
const tally = {};
for (const r of clean) tally[r.phaseA.classification] = (tally[r.phaseA.classification] || 0) + 1;
log(`Batch done. ${clean.length}/${indices.length} processed. classifications: ${JSON.stringify(tally)}`);
return { results: clean, tally };
