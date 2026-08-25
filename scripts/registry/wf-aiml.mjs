export const meta = {
  name: 'curate-aiml-subcats',
  description: 'Curate the 6 remaining ai-ml subcategories in parallel (each agent writes its curation/<slug>.json)',
  phases: [{ title: 'Curate', detail: 'one curation agent per subcategory' }],
}

const ROOT = process.cwd()

const SUBCATS = [
  { slug: 'ai-model-hosting-inference', unit: 'per call', hint:
    "Services to HOST or RUN models / generic inference gateways (e.g. Baseten, Together, Fireworks, Replicate-style 'run any model', GPU inference, model deployment, custom hosted model endpoints). CRITICAL: plain chat LLMs and chat gateways are ALREADY catalogued in curation/llm-chat-apis.json — READ that file first and do NOT duplicate any service already there (match by backend host/url/model). Keep ONLY genuine model-hosting / inference-infrastructure or NON-chat inference services unique to this subcategory. Few clean entries beats duplicating llm-chat-apis." },
  { slug: 'embeddings-vector', unit: 'per call', hint:
    "Text/image EMBEDDING generation models and endpoints (e.g. text-embedding-3, BGE, Cohere embed, voyage, nomic). NOT vector databases (that is the separate vector-databases subcategory) — only embedding GENERATION. One entry per recognizable embedding model; merge same model across gateways into backends." },
  { slug: 'vision-image-recognition', unit: 'per call', hint:
    "Image UNDERSTANDING / recognition / analysis: object detection, image classification, captioning, vision-LLM analysis, visual Q&A, logo/landmark/face detection. NOT image GENERATION (already done in image-generation). Background removal / editing belong to image-video-processing. OCR may belong to ocr-document-extraction — route pure OCR away unless it is general vision." },
  { slug: 'nlp-text-analysis', unit: 'per call', hint:
    "Text analysis utilities: LANGUAGE DETECTION (central here — many candidates), named-entity extraction, sentiment analysis, text classification, keyword extraction, summarization-as-analysis, readability, PII detection. NOT translation (own subcategory), NOT content moderation (own subcategory), NOT general chat LLMs (already in llm-chat-apis)." },
  { slug: 'translation', unit: 'per call', hint:
    "Machine TRANSLATION services that translate text between languages (general translation, document translation, multilingual translate APIs/models). Language DETECTION is nlp-text-analysis, not translation — route it away." },
  { slug: 'content-moderation', unit: 'per call', hint:
    "Content MODERATION / trust & safety: toxicity, NSFW/adult detection, hate-speech, abuse/spam detection, image/text safety classification, profanity filtering, compliance screening." },
]

const SCHEMA = {
  type: 'object',
  required: ['subcategory', 'curationFilePath', 'kept', 'droppedCount', 'entries'],
  properties: {
    subcategory: { type: 'string' },
    curationFilePath: { type: 'string', description: 'absolute path of the curation JSON you wrote' },
    kept: { type: 'number', description: 'number of entries written' },
    droppedCount: { type: 'number' },
    contaminationRouted: { type: 'array', items: { type: 'string' }, description: 'services routed to other subcategories with their target subcat' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'provider', 'kind', 'backends'],
        properties: {
          name: { type: 'string' }, provider: { type: 'string' }, kind: { type: 'string' },
          backends: { type: 'array', items: { type: 'number' } },
          status: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const rules = (s) => `You are a curation agent for the MasterKey x402 service registry. Curate ONE subcategory: "${s.slug}" (category: ai-ml).

WORKING DIR: ${ROOT}  (all paths below are relative to it)

STEP 1 — Read for context (use the Read tool):
  - SPEC.md  (skim sections 1, 3, 5 — the inclusion filter, schema, and "Claude is the curator" pipeline)
  - scripts/registry/curation/image-generation.json   (GOLD-STANDARD example — match this style & quality)
  - scripts/registry/curation/llm-chat-apis.json       (GOLD-STANDARD example, same category — match this exactly, incl. the "unit" field and the _note documenting drops/contamination)
  - scripts/registry/candidates/${s.slug}.json         (YOUR candidates — read EVERY one)

To read candidates compactly, run this in Bash:
  node -e 'const d=require("./scripts/registry/candidates/${s.slug}.json");d.candidates.forEach((c,i)=>{const net=(c.accepts||[]).map(a=>a.network).join(",");const sum=(c.check&&c.check.summary)||"";const desc=(c.description||"").replace(/\\s+/g," ");const p=c.price?(c.price.amount==null?"varies":"$"+c.price.amount):"-";console.log("#"+i+" ["+(c.payable?"PAY":"---")+"] "+p+" "+c.host+c.path);if(desc)console.log("   "+desc.slice(0,200));if(sum)console.log("   sum: "+String(sum).replace(/\\s+/g," ").slice(0,160));if(net)console.log("   net: "+net);});'
Also check payment evidence for non-payable rows (authMode/accepts) the same way you see fit (fields: payable, probeStatus, authMode, accepts, price, check.inputSchema, url, host, hosting, platformName).

THIS SUBCATEGORY: ${s.hint}

STEP 2 — Curate with judgment (read every candidate):
  KEEP only real services that genuinely belong in "${s.slug}" AND are callable payment-or-nothing:
    - live 402 (payable:true) → KEEP, price from candidate price.amount (USDC, already converted to USD).
    - free 2xx (non-trivial) → KEEP.
    - blocked/404/null probe BUT has payment evidence (authMode contains x402 / =paid / =siwx, or accepts present) → KEEP with "status":"needs-review".
    - non-402 error with NO payment evidence (needs an upstream API key, authMode apiKey with no accepts) → DROP.
  DROP: cross-category contamination (do NOT include — note it in contaminationRouted with the target subcategory), junk/test/demo ("x402 Helper API" on x402helper.xyz, "USDC micropayments..." blurbs), llms.txt / model-list / /health / /models meta endpoints (discovery only), internal /cron /webhook /admin, preview deploys (hosts with -git- in a *.vercel.app name), unidentifiable junk.
  DEDUP SEMANTICALLY: the SAME model/service offered by multiple gateways = ONE entry with multiple "backends" (list all their candidate indices; the cheapest price is surfaced automatically). Recognize variants by reading descriptions.
  CLEAN names to recognizable form; classify; assign tags + modality {input:[...],output:[...]}.
  PLATFORM-HOSTED backends (hosting:"platform", e.g. *.vercel.app, *.up.railway.app, *.workers.dev) → the entry should get "status":"needs-review" if ALL its backends are platform-hosted (the assembler also auto-sets this, but set it explicitly when unsure).

STEP 3 — Drill exact prices with agentcash (ONLY for shortlisted KEEP entries whose backend price is unknown/"varies" but the row is payable or has evidence):
  Load the tool: ToolSearch query "select:mcp__agentcash__check_endpoint_schema" then call check_endpoint_schema({url: "<exact url field from candidates json>", method: "POST"}).
  The exact price = paymentOptions[0].maxAmountRequired / 1e6 (USDC on Base/Solana = 6 decimals). Record it in the entry's "resolved" map: { "<idx>": { "amount": <usd-number> } }.
  agentcash only covers some services — if it returns "No endpoint schema found", do NOT drop; just leave price as-is (Varies + needs-review). Never block on it.

STEP 4 — Write your decisions to scripts/registry/curation/${s.slug}.json (use the Write tool) with EXACTLY this shape (match llm-chat-apis.json):
  {
    "subcategory": "${s.slug}",
    "category": "ai-ml",
    "unit": "${s.unit}",
    "_note": "Curated by claude-aiml workflow. backends=candidate indices. resolved=agentcash exact prices. <document key drops + contamination routing here>",
    "entries": [
      { "name": "...", "provider": "...", "providerId": "...", "kind": "model" (omit or "api" for multi-model gateways/multi-op services),
        "aka": ["..."], "description": "<clean human + agent-useful>",
        "tags": ["..."], "modality": { "input": ["text"], "output": ["..."] },
        "backends": [<idx>, ...], "resolved": { "<idx>": { "amount": 0.01 } }, "status": "needs-review" (optional) }
    ]
  }
  - "backends" are integer indices into candidates/${s.slug}.json. providerId = lowercase-kebab of provider. kind defaults to "model"; use "api" for multi-model gateways / multi-operation services.
  - DO NOT run curate.mjs (the orchestrator runs it). Only write the curation JSON.

STEP 5 — Return the structured summary (you will be forced to call StructuredOutput). curationFilePath must be the absolute path you wrote. List every entry with name/provider/kind/backends/status. Put the drop count and any contamination routing in the summary.

Quality bar: every entry is a recognizable model/service, correctly in "${s.slug}", deduped, exact prices where resolvable, junk removed, uncertain flagged needs-review. Be thorough and use semantics, not just keywords.`

phase('Curate')
const results = await parallel(SUBCATS.map((s) => () =>
  agent(rules(s), { label: `curate:${s.slug}`, phase: 'Curate', schema: SCHEMA })
    .then((r) => ({ ...r, slug: s.slug }))
    .catch((e) => ({ slug: s.slug, error: String(e) }))
))

return results
