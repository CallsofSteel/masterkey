export const meta = {
  name: "multiop-audit",
  description: "Audit multi-backend/operation services for the Exa-class incompatible-bundle routing bug (read-only)",
  phases: [{ title: "Audit" }],
};

// args = { count, candidatesFile, projectRoot? }  — index-based to avoid a huge args payload.
const ROOT = (args && args.projectRoot) || process.cwd();
const CANDFILE = (args && args.candidatesFile) || `${ROOT}/scripts/registry/.audit-candidates.json`;
const COUNT = (args && args.count) || 0;
if (!COUNT) { log("no count"); return { findings: [] }; }
const cands = Array.from({ length: COUNT }, (_, i) => i);
log(`Auditing ${COUNT} multi-backend/op services for incompatible-input bundling (read-only).`);

// One node call per agent: read candidate[i] {id,file} from the candidates file, then print a TRIMMED
// view of that service (no accepts/probe blobs) so only what matters enters the agent's context.
const extract = (i) =>
  `node -e 'const c=require("${CANDFILE}")[${i}]; const BY="${ROOT}/data/registry/by-subcat/"; const s=c&&require(BY+c.file).find(x=>x.id===c.id); if(!s){process.stdout.write("__NONE__")}else{const t=o=>({url:o.url,method:o.method,name:o.name,inputSchema:o.inputSchema?Object.keys((o.inputSchema.properties)||{}).concat((o.inputSchema.parameters||[]).map(p=>p.name)):null,status:o.status,firstParty:o.firstParty}); process.stdout.write(JSON.stringify({id:s.id,name:s.name,kind:s.kind,backends:(s.backends||[]).filter(b=>b&&typeof b===\"object\"&&b.status!==\"hidden\").map(t),operations:(s.operations||[]).map(t),usage:{callShape:s.usage&&s.usage.callShape,inputExample:s.usage&&s.usage.inputExample,quirks:s.usage&&s.usage.quirks}}))}'`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "verdict", "reason", "recommendation"],
  properties: {
    id: { type: "string" },
    // ok = backends/ops are interchangeable (same input) OR properly selectable; the no-hint default is safe.
    // bug = backends bundle DIFFERENT operations with INCOMPATIBLE required inputs, so a no-hint call (engine
    //       picks first-party-then-cheapest) can route the documented input to the wrong endpoint → failure.
    // review = uncertain / needs a human or a paid probe.
    verdict: { type: "string", enum: ["ok", "bug", "review"] },
    reason: { type: "string" },
    recommendation: { type: "string" }, // if bug/review: how to fix (un-bundle into which ops; canonical default)
    distinctInputShapes: { type: "number" }, // how many genuinely different input shapes across the backends/ops
  },
};

function prompt(i) {
  return `You are auditing ONE MasterKey registry service (candidate index ${i}) for the "incompatible-bundle" routing bug.

BACKGROUND: the run engine treats a service's backends as INTERCHANGEABLE — when the agent calls a service without pinning a provider/operation, the engine picks ONE target (first-party, else cheapest) and sends the SAME input body to it. This is SAFE only if every selectable backend/operation accepts the SAME input shape (e.g. several gateways all proxying the same "search" op with {query}). It is a BUG when a service bundles DIFFERENT operations with DIFFERENT required inputs as if interchangeable — e.g. Exa bundled search({query}), find-similar({url}), contents({urls}) so a documented {query} call got routed to the cheapest (contents) and 400'd.

## STEP 1 — load the service (read-only)
Run: \`${extract(i)}\`
It prints JSON: {id,name,kind,backends:[{url,method,inputSchema(field names or null)}],operations:[...],usage:{callShape,inputExample,quirks}}. Use its \`id\` as your answer's id. (If "__NONE__", return id "none-${i}", verdict "review", reason "service not found".)

## STEP 2 — judge
Look at the SELECTABLE targets (active backends + operations). Decide whether they need the SAME input or DIFFERENT inputs:
- Same op via multiple gateways/providers (e.g. all .../search, or chat /completions vs /messages — same {messages} body; image generate+edit handled by the engine's edit-aware routing) → verdict "ok".
- Genuinely DIFFERENT operations with different required fields bundled as backends (search vs contents vs answer; provision vs send vs call; /price vs /klines vs /sql) where a single documented input can't satisfy all, and there's NO per-operation selector the agent would naturally pass → verdict "bug".
- If the service uses operations[] that the agent selects explicitly AND get_service documents them, that's safer → lean "ok" unless the inputs differ AND there's no clear default.
- Infer input differences from the URL terminal segments + inputSchema field names + usage.callShape/quirks. You may NOT make paid calls; this is static analysis only.
Set distinctInputShapes = how many different input shapes you counted.

## STEP 3 — return
- verdict: ok | bug | review
- reason: 1-2 sentences citing the specific endpoints/inputs.
- recommendation: if bug/review, how to fix (e.g. "un-bundle into <ops>; default <provider/op>"). Empty if ok.
Return the structured object (use the loaded service's id). Your final answer IS the data.`;
}

const findings = await pipeline(
  cands,
  (i) => agent(prompt(i), { label: `audit:#${i}`, phase: "Audit", schema: SCHEMA }),
);

const clean = findings.filter(Boolean);
const tally = {};
for (const f of clean) tally[f.verdict] = (tally[f.verdict] || 0) + 1;
const bugs = clean.filter((f) => f.verdict === "bug");
log(`Audit done. ${clean.length}/${cands.length} analyzed. ${JSON.stringify(tally)}. BUGS: ${bugs.map((b) => b.id).join(", ") || "none"}`);
return { findings: clean, tally, bugs };
