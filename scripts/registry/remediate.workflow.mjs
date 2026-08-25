export const meta = {
  name: "remediate-providers",
  description: "Per-service: discover each provider's real shape, verify with one paid call/op, return structured per-op docs (money-safe)",
  phases: [{ title: "Verify & document" }],
};

// args = { count, file, projectRoot?, perCallCap?, sprintCeiling? }  — index-based over a pending list.
const ROOT = (args && args.projectRoot) || process.cwd();
const PENDING = (args && args.file) || `${ROOT}/scripts/registry/.remediation-pending.json`;
const COUNT = (args && args.count) || 0;
const OFFSET = (args && args.offset) || 0;
const CAP = (args && args.perCallCap) || 0.6;
const CEIL = (args && args.sprintCeiling) || 40;
const PAY = `${ROOT}/scripts/registry/dist/qa-pay.mjs`;
if (!COUNT) { log("no count"); return { results: [] }; }
const idx = Array.from({ length: COUNT }, (_, i) => OFFSET + i);
log(`Remediating ${COUNT} services: discover schema (free) → verify each op (1 paid call, cap $${CAP}, sprint ceiling $${CEIL}) → structured per-op docs. Outward sends are NEVER auto-called.`);

// Print a trimmed view of service[i] from the pending list + its by-subcat detail.
const extract = (i) =>
  `node -e 'const c=require("${PENDING}")[${i}]; const s=c&&require("${ROOT}/data/registry/by-subcat/"+c.file).find(x=>x.id===c.id); if(!s){process.stdout.write("__NONE__")}else{const t=b=>({url:b.url,method:b.method,provider:b.provider,providerId:b.providerId,price:b.price&&b.price.amount,firstParty:b.firstParty,inputSchema:b.inputSchema?Object.keys((b.inputSchema.properties)||{}).concat((b.inputSchema.parameters||[]).map(p=>p.name)):null}); process.stdout.write(JSON.stringify({id:s.id,name:s.name,kind:s.kind,category:s.category,subcategory:s.subcategory,backends:(s.backends||[]).filter(b=>b&&typeof b===\"object\"&&b.status!==\"hidden\").map(t),usage:{callShape:s.usage&&s.usage.callShape,inputExample:s.usage&&s.usage.inputExample,quirks:s.usage&&s.usage.quirks}}))}'`;

const SVC = {
  type: "object",
  additionalProperties: false,
  required: ["name", "providerId", "op", "description", "backends", "inputExample", "callShape", "outputShape", "quirks", "costObservedUsd", "verified", "outward", "status"],
  properties: {
    name: { type: "string" },        // human service name, e.g. "Apollo People Search"
    providerId: { type: "string" },  // stable provider id, e.g. "apollo"
    op: { type: "string" },          // operation key, e.g. "people-search"
    description: { type: "string" },
    backends: { type: "array", items: { type: "object", additionalProperties: true } }, // [{url,method,provider,price,default?}]
    inputExample: { type: "object", additionalProperties: true },
    callShape: { type: "string" },
    outputShape: { type: "string" },
    quirks: { type: "array", items: { type: "string" } },
    costObservedUsd: { type: "number" },
    verified: { type: "boolean" },   // a real paid call returned 2xx
    outward: { type: "boolean" },    // op sends/places/books/pays/provisions → NOT auto-called
    status: { type: "string", enum: ["verified", "needs-input", "broken", "outward-unverified", "over-cap"] },
    httpStatus: { type: "number" },
  },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "classification", "note", "services"],
  properties: {
    id: { type: "string" },
    // split = backends are DIFFERENT operations → many services; multi-gateway = SAME op via many providers → 1 service many backends; single = effectively one
    classification: { type: "string", enum: ["split", "multi-gateway", "single", "skip"] },
    note: { type: "string" },
    services: { type: "array", items: SVC },
  },
};

function prompt(i) {
  return `You are remediating ONE MasterKey registry service (index ${i}). GOAL: figure out each PROVIDER's real calling convention and produce correct, verified per-operation documentation. You will spend REAL money (one paid call per operation) — be careful and money-safe.

## STEP 1 — load the service
Run: \`${extract(i)}\`
Prints {id,name,kind,category,subcategory,backends:[{url,method,provider,providerId,price,firstParty,inputSchema}],usage}. If "__NONE__", return {id:"none-${i}",classification:"skip",note:"not found",services:[]}.

## STEP 2 — discover each provider's REAL schema (FREE, before paying)
The current usage was written ONCE for the whole service and is probably wrong for some backends. For the backend ORIGINS, discover the true per-endpoint input/output schema for FREE:
- Prefer MCP: use ToolSearch to load \`mcp__agentcash__discover_api_endpoints\` and \`mcp__agentcash__check_endpoint_schema\`, then call them on the backend origin/url (free, returns exact input fields, output, price, guidance). Known rich origins: stableenrich.dev, stablestudio.dev, stablesocial.dev, x402.orth.sh, blockrun.ai.
- Else: try fetching \`<origin>/openapi.json\` or \`<url>/openapi.json\`, or read the unpaid 402 challenge body (it sometimes carries an input/output schema).
Determine, per backend, the REAL minimal input shape + output shape.

## STEP 3 — classify the backends
- "split": the backends are DIFFERENT operations with different inputs (e.g. people-search vs org-search vs enrich) → each becomes its OWN service.
- "multi-gateway": the backends are the SAME operation via different gateways/providers (e.g. one model via 3 gateways) → ONE service with multiple backends. Mark the best DEFAULT backend (firstParty if any, else cheapest verified) with default:true.
- "single": only one is really usable.

## STEP 4 — verify each resulting operation with ONE paid call (money-safe)
For each operation (each output service), build the SMALLEST valid input from the discovered schema, write it to /tmp/rem-${i}-<n>.json, and pay ONCE:
\`QA_SPRINT_CEILING=${CEIL} QA_SPRINT_PREFIX=remediate node ${PAY} --url='<url>' --method='<METHOD>' --cap=${CAP} --body=@/tmp/rem-${i}-<n>.json --label='remediate-${i}-<n>'\`
(GET ops: pass query params in the URL, method GET, no body.) qa-pay prints {classification,status,paid,costUsd,bodyPreview,error}.
GET x402 FALLBACK: qa-pay sometimes can't complete the x402 flow on GET endpoints (returns 402 with empty body, paid:false). If that happens, verify the GET via the MCP tool instead: ToolSearch-load \`mcp__agentcash__fetch\` and call it on the full URL (it pays + returns the body). Record the cost it reports.
RULES:
- NEVER auto-call an OUTWARD/irreversible op — anything that SENDS (email/SMS/message), PLACES a call, BOOKS, PAYS/charges beyond the x402 fee, SHIPS, PROVISIONS a number/resource, or POSTS public content. For those set outward:true, status:"outward-unverified", verified:false, document the shape from discovery only (NO paid call).
- One paid call per op (max 2 if the first reveals a clear fixable field error). If "budget-exhausted" → status "needs-input", verified false, stop paying. If "over-cap" → status "over-cap".
- For a multi-gateway service, verify the DEFAULT backend (one call); note the others as same-op (don't pay each unless shapes clearly differ).
- Capture the REAL output shape from the 2xx bodyPreview.

## STEP 5 — return structured per-op documentation
Return {id, classification, note, services:[...]}. For each service: name (e.g. "<Service> <Op>"), providerId, op, description, backends:[{url,method,provider,price,default?}], inputExample (the REAL body that worked), callShape, outputShape (dot-paths from the real response), quirks (EXACT gotchas incl. field-name traps, async/poll, obfuscation, state_code-style), costObservedUsd, verified, outward, status, httpStatus.
For "split": one entry per operation. For "multi-gateway": ONE entry whose backends[] lists all providers (default:true on the chosen default). Be precise and complete — this goes straight into the production registry. Your final answer IS the data.`;
}

const results = await pipeline(
  idx,
  (i) => agent(prompt(i), { label: `rem:#${i}`, phase: "Verify & document", schema: SCHEMA }),
);
const clean = results.filter(Boolean);
const tally = {};
for (const r of clean) tally[r.classification] = (tally[r.classification] || 0) + 1;
const svcCount = clean.reduce((n, r) => n + (r.services ? r.services.length : 0), 0);
log(`Done. ${clean.length}/${COUNT} services processed → ${svcCount} op-services documented. classifications: ${JSON.stringify(tally)}`);
return { results: clean, tally };
