export const meta = {
  name: 'apify-index',
  description: 'Index a batch of Apify x402 actors: pay-test 3 (characterize exact/upto + refund), enrich the rest live (input schema + accepts), in parallel.',
  phases: [
    { title: 'Verify (paid x402)', detail: 'pay-test 3 random actors; confirm output shape + refund' },
    { title: 'Enrich (free)', detail: 'per-chunk: live input schema + accepts for every actor' },
  ],
};

const ROOT = args.projectRoot;
const QAPAY = `${ROOT}/scripts/registry/dist/qa-pay.mjs`;
const ENRICH = `${ROOT}/scripts/registry/apify-enrich.mjs`;

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['actorId', 'ok', 'status', 'qaPayCostUsd', 'outputShape', 'sampleKeys', 'note'],
  properties: {
    actorId: { type: 'string' },
    ok: { type: 'boolean', description: 'true only if a real dataset array came back' },
    status: { type: 'integer' },
    qaPayCostUsd: { type: 'number', description: 'cost qa-pay reported (the exact $ captured, before refund)' },
    outputShape: { type: 'string', description: 'concrete shape of the returned data, e.g. "array of objects with keys {id,url,caption,likes}"' },
    sampleKeys: { type: 'array', items: { type: 'string' }, description: 'top-level keys of the first dataset row' },
    note: { type: 'string', description: 'anything notable (slow run, input quirk, error)' },
  },
};
const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outFile', 'count', 'withAccepts', 'failures'],
  properties: {
    outFile: { type: 'string' }, count: { type: 'integer' },
    withAccepts: { type: 'integer', description: 'how many records captured x402 accepts' },
    failures: { type: 'integer', description: 'actors that errored during enrich' },
  },
};

// ---- Phase 1: pay-test 3 representative actors (real money, cap $1.10) ----
phase('Verify (paid x402)');
const tested = await parallel((args.verifyActors || []).map((actorId) => () =>
  agent(
    `Pay-test the Apify x402 actor "${actorId}" with a real call (money-safe). Steps, run with Bash (cwd is NOT the project — use absolute paths):\n` +
    `1. GET https://api.apify.com/v2/acts/${actorId} → read .data.taggedBuilds.latest.buildId, then GET https://api.apify.com/v2/acts/${actorId}/builds/<buildId> → .data.inputSchema. Build a MINIMAL valid JSON body from the schema's "prefill"/"default" values for required fields; TRIM any result-count fields to 1 (e.g. resultsLimit:1, maxItems:1). Write it to /tmp/apify-vbody-${actorId.replace(/[^a-z0-9]+/gi, '_')}.json.\n` +
    `2. Pay exactly once:\n   node ${QAPAY} --url='https://api.apify.com/v2/actors/${actorId}/run-sync-get-dataset-items?maxTotalChargeUsd=0.50&maxItems=1' --method=POST --cap=1.10 --body=@/tmp/apify-vbody-${actorId.replace(/[^a-z0-9]+/gi, '_')}.json --label=apify-verify-${actorId.replace(/[^a-z0-9]+/gi, '_')} --save=/tmp/apify-vout-${actorId.replace(/[^a-z0-9]+/gi, '_')}.json\n` +
    `   qa-pay enforces the $1.10 ceiling and prints one JSON line (classification/ok/status/costUsd). Pay AT MOST ONCE — if it fails, do NOT retry with payment.\n` +
    `3. Read the saved /tmp/apify-vout-*.json (the response body = a JSON array of dataset rows). Describe outputShape concretely and list the first row's top-level keys.\n` +
    `Return the structured result. ok=true only if status 2xx AND a non-empty dataset array came back.`,
    { schema: VERIFY_SCHEMA, label: `verify:${actorId}`, phase: 'Verify (paid x402)' },
  ).then((r) => (r ? { ...r, actorId } : null)),
));

// ---- Phase 2: enrich every chunk (free GETs: pricing + input schema + accepts) ----
phase('Enrich (free)');
const chunks = await parallel((args.chunkFiles || []).map((inFile, i) => () => {
  const outFile = inFile.replace('apify-chunk', 'apify-enriched');
  return agent(
    `Enrich an Apify actor chunk for the registry. Run with Bash (absolute paths):\n` +
    `  node ${ENRICH} --in=${inFile} --out=${outFile}\n` +
    `This GETs each actor's live pricing + input schema (prefills) and probes the x402 402 for accepts (exact+upto), writing enriched records to ${outFile}. It prints "enriched N actors (with-accepts: M)".\n` +
    `Then read ${outFile} and report: outFile, count (records), withAccepts (records whose accepts[] is non-empty), failures (records with an _err field). Do not pay for anything.`,
    { schema: ENRICH_SCHEMA, label: `enrich:chunk-${i}`, phase: 'Enrich (free)' },
  );
}));

return { tested: tested.filter(Boolean), chunks: chunks.filter(Boolean) };
