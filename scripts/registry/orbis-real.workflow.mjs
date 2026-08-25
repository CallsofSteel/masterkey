export const meta = {
  name: "orbis-real",
  description: "Re-test Orbis the CORRECT way: fetch each actor's own openapi.json and call a REAL route (not the base /proxy/<slug>), then pay. Charge-then-404 aware, fresh sprint budget.",
  phases: [{ title: "Test real routes (paid)" }],
};

// args = { file, offset?, limit, cap?, sprintCeiling?, sprintPrefix?, projectRoot? }
const ROOT = (args && args.projectRoot) || process.cwd();
const FILE = (args && args.file) || "/tmp/orbis-real-batch.json";
const OFFSET = (args && args.offset) || 0;
const LIMIT = (args && args.limit) || 0;
const PAY = `${ROOT}/scripts/registry/dist/qa-pay.mjs`;
const CAP = (args && args.cap) || 0.1;
const CEIL = (args && args.sprintCeiling) || 5;
const PREFIX = (args && args.sprintPrefix) || "orbisreal";
const RESULTS = `${ROOT}/data/registry/qa-results`;

if (!LIMIT) { log("No limit passed."); return { results: [] }; }
const indices = Array.from({ length: LIMIT }, (_, i) => OFFSET + i);
log(`Orbis REAL-route test: ${LIMIT} actors | per-call cap $${CAP} | sprint ceiling $${CEIL} (prefix ${PREFIX})`);

const extract = (i) => `node -e 'const a=require("${FILE}").endpoints[${i}]; process.stdout.write(a?JSON.stringify(a):"__NONE__")'`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["key", "slug", "classification", "realRoute", "fullUrl", "method", "paid", "costUsd", "httpStatus", "callShape", "inputExample", "outputShape", "quirks", "guide", "costObservedUsd", "notes"],
  properties: {
    key: { type: "string" }, slug: { type: "string" },
    classification: { type: "string", enum: ["verified", "verified-with-quirks", "broken", "over-cap", "budget-skip", "needs-input"] },
    realRoute: { type: "string", description: "the openapi path chosen, e.g. /trenches/new-tokens" },
    fullUrl: { type: "string", description: "the full URL actually called (proxyUrl + route + query)" },
    method: { type: "string" },
    paid: { type: "boolean" }, costUsd: { type: "number" }, httpStatus: { type: "integer" },
    callShape: { type: "string" }, inputExample: { type: "object", additionalProperties: true },
    outputShape: { type: "string", description: "where the real computed result is, or empty if broken" },
    quirks: { type: "array", items: { type: "string" } },
    guide: { type: "string" }, costObservedUsd: { type: "number" },
    notes: { type: "string" },
  },
};

function prompt(i) {
  return `Test ONE Orbis actor by calling a REAL route from its OWN OpenAPI spec — NOT the base /proxy/<slug> (that only returns a descriptor or 404, which is why naive tests "charge-then-404"). This is money-real x402; be precise and pay AT MOST ONCE. Your cwd is NOT the project — use the absolute paths verbatim.

## STEP 1 — get the spec (no pay)
Run: ${extract(i)}
→ JSON { key, slug, name, price, proxyUrl, openapiUrl }. If "__NONE__", return classification "needs-input", notes "no spec".

## STEP 2 — fetch the actor's REAL routes (FREE — do NOT pay)
Fetch the openapiUrl, e.g.: \`curl -s --max-time 20 '<openapiUrl>'\`
Parse \`.paths\`. Pick ONE route most likely to return real data with inputs you can supply:
- Prefer a GET with no required params (or required params you can fill from the schema's example/default/enum or a sensible value).
- Else a POST with a small JSON body built from its requestBody schema.
- Substitute any {pathParam} with a sensible sample. AVOID routes needing an API key, auth token, or a real id you cannot obtain.
Build the FULL url = proxyUrl + chosen path (+ ?query for GET params).

## STEP 3 — idempotency
SAFE = key with every non-alphanumeric replaced by "_". If ${RESULTS}/<SAFE>.a.json exists with "paid":true or a terminal classification, REUSE it (return that data; do not pay again).

## STEP 4 — pay EXACTLY ONCE (per-call cap $${CAP}, sprint ceiling $${CEIL})
For POST: write the body to /tmp/qa-<SAFE>.json (Write tool). Then:
\`QA_SPRINT_CEILING=${CEIL} QA_SPRINT_PREFIX=${PREFIX} node ${PAY} --url='<fullUrl>' --method='<GET|POST>' --cap=${CAP} ${"${BODYARG}"} --label='<key>'\`
(BODYARG = \`--body=@/tmp/qa-<SAFE>.json\` for POST, omit for GET.) qa-pay prints ONE JSON line {classification, paid, costUsd, status, bodyPreview}.
- If qa-pay classification "budget-exhausted" → your classification "budget-skip", paid false. Stop.
- If "over-cap" → "over-cap". Stop.

## STEP 5 — classify from the POST-payment response body
- "verified": HTTP 2xx with a REAL computed result (actual data fields), NOT a {status/service/version} descriptor and NOT an error.
- "verified-with-quirks": worked but needed a non-obvious route/body/param.
- "broken": 404 / HTML error / "API_NOT_FOUND" / "Invalid API key" / descriptor-only stub / garbage. (Orbis charge-then-404 — do NOT retry, do NOT try other routes; one more route is allowed ONLY if the first clearly pointed to it.)
Document: realRoute, fullUrl, method, callShape (real route+method), inputExample (what you sent), outputShape (dot-path to the result, or "" if broken), quirks, guide (2-3 sentences), costObservedUsd (real $ from qa-pay).
Write your raw result to ${RESULTS}/<SAFE>.a.json (Write tool). Return the structured object — your final answer IS the data.`;
}

const results = (await pipeline(indices, (i) => agent(prompt(i), { label: `orbis:#${i}`, phase: "Test real routes (paid)", schema: SCHEMA }))).filter(Boolean);
const tally = {};
for (const r of results) tally[r.classification] = (tally[r.classification] || 0) + 1;
log(`Done. ${results.length}/${indices.length}. classifications: ${JSON.stringify(tally)}`);
return { results, tally };
