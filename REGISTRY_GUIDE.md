# MasterKey Registry — Integration Guide

A walkthrough for anyone who wants to **index, mirror, or consume** the MasterKey
registry in their own system. You don't need to know anything about the MasterKey
app or its agent — this document covers only the registry: what's in it, which
services work, what they return, what they cost, how to call and pay for them, and
exactly where to fetch every field.

> **What the registry is, in one line:** a curated, *live-verified* catalog of
> **x402-payable** APIs and AI models — every active entry was actually called and
> paid for at least once, with the working request body and response shape recorded.

---

## 1. At a glance

| | |
|---|---|
| **Active (working) services** | **426** |
| Of which AI models | 115 (`kind: "model"`) |
| Of which APIs | 311 (`kind: "api"`) |
| Categories / subcategories | 19 / 60+ |
| Payment protocol | x402 (HTTP 402 micropayments) — 506 backends; SIWX (free, wallet-identity) — a handful; generic `paid` — 23 |
| Settlement chains | Mostly **Base USDC**; many also accept **Solana USDC** + **Polygon USDC**; a long tail of other EVM chains |
| Result delivery | sync (380), async/poll (44), siwx (2) |
| Verification | **100% of active entries have `usage.status: "verified"`** with a `verifiedAt` date and the real `costObservedUsd` |

Every active service is self-describing: the entry tells you the endpoint URL, the
HTTP method, a **real request body that produced a real result**, where the result
lives in the response, the exact price, the payment instructions, and any gotchas.

---

## 2. Where the data lives — two ways to get it

The registry has **two layers**:

1. **Summary layer** — lightweight catalog cards (name, provider, category, price,
   tags, status). Good for browse/search/index building.
2. **Detail layer** — the full record per service: backend endpoint(s), payment
   routing (networks/asset/amount/`payTo`), and a `usage` block telling you exactly
   how to call it. **This is the valuable part** — treat it as confidential.

You can take either layer via the **live HTTP API** or by **copying the JSON files**.

### Option A — Live HTTP API (recommended for staying in sync)

Base URL: `https://masterkey.sh`

| Endpoint | Returns | Layer |
|---|---|---|
| `GET /api/catalog` | The manifest: category tree + all summary entries + `syncedAt` | Summary |
| `GET /api/subcat/{slug}` | Full `Service[]` detail (backends + payment + usage) for **one** subcategory | Detail |

- The API **automatically hides** dead/broken services — it returns **only the 426
  active** services and only their active backends. What you get is already clean.
- There is **deliberately no "dump everything" endpoint.** Detail is per-subcategory
  only. To mirror the whole detail layer, read `/api/catalog`, collect the subcategory
  slugs, then fetch `/api/subcat/{slug}` for each (≈60 calls).
- **Rate limit: 60 requests / minute / IP** (sliding window; returns `429` when
  exceeded). Crawl politely — ~60 subcat calls is one quiet minute.

```bash
# 1. Get the catalog (categories + summaries)
curl https://masterkey.sh/api/catalog

# 2. Get full detail for one subcategory
curl https://masterkey.sh/api/subcat/image-generation
```

### Option B — Copy the JSON files (best for a one-time bulk ingest)

The registry is committed as plain JSON. If you have a copy of the registry tree
(`data/registry/`), these are the only files you need:

| File | Contents |
|---|---|
| `index.json` | The manifest: `{ syncedAt, categories[], entries[] }` — summary layer for **all** services |
| `by-subcat/{slug}.json` | Full `Service[]` for one subcategory — the detail layer |
| `meta.json` | `{ syncedAt, totalServices, perSubcategory{} }` — counts |
| `first-party.json` | The map used to flag first-party backends (reference only; the flag is already baked into each backend as `firstParty: true`) |

> ⚠️ **Files contain hidden entries; the API does not.** The raw files keep
> dead/broken services as a durable record (`status: "hidden"` + a `hiddenReason`).
> If you ingest the files directly, **filter to `status === "active"`** at the service
> level, and drop any backend with `status === "hidden"`. The live API already does
> this for you. Everything below assumes you've kept only active records.

(Anything else in `data/registry/` — `qa-*`, `_remediation-*`, `orbis-*`,
`candidates/`, `curation/` — is internal build/QA scaffolding. Ignore it.)

---

## 3. The data model

A registry unit is a **`Service`**. Authoritative TypeScript types live in
`src/data/types.ts`; this section is the practical summary.

### 3.1 Service (the top-level record)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable slug — your primary key |
| `kind` | `"model"` \| `"api"` | `model` = one AI model (may be served by several `backends[]`); `api` = one callable service/operation |
| `name` | string | Clean display name |
| `aka` | string[] | Aliases / raw names — **index these for search** |
| `provider` / `providerId` | string | Who runs it |
| `description` | string | One-paragraph human description |
| `category` / `subcategory` | string (slug) | Taxonomy placement (see §7) |
| `tags` | string[] | Keywords |
| `modality` | `{ input[], output[] }` | e.g. input `["text"]`, output `["json"]`/`["image"]` |
| `pricing` | `{ headline, amount, currency, unit }` | Human price, e.g. `{ "$0.021", 0.021, "USD", "per image" }` (`amount: null` = "Varies") |
| `backends` | `Backend[]` | **The callable endpoints** (see §3.2). Present on virtually every active entry. |
| `operations` | `Operation[]` | Multi-action services (mostly empty in the active set — each action is its own `Service`) |
| `usage` | `ServiceUsage` | **How to call it correctly** (see §3.3) — the most useful block |
| `docs` | `{ llmTxt?, agentMd?, openapi? }` | Doc links, when known |
| `status` | `"active"` \| `"needs-review"` \| `"hidden"` | **`active` = verified working.** Index only these. |
| `hiddenReason` | enum | On hidden entries only: `dead` (errored/returned nothing), `broken` (charged then failed), `mpp` (wrong protocol), `untested`, `needs-input`, `over-cap`, `needs-review` |

### 3.2 Backend (one gateway that serves the service)

A service may have several backends (e.g. the same AI model offered by multiple
gateways). They're sorted with the **first-party / cheapest backend first** — default
to `backends[0]` unless you want to pin a specific provider.

| Field | Type | Meaning |
|---|---|---|
| `provider` / `providerId` | string | The gateway |
| `url` | string | **The endpoint to call** |
| `method` | string | `GET` / `POST` / … |
| `authMode` | `"x402"` \| `"siwx"` \| `"paid"` | How you authenticate the call (see §6) |
| `firstParty` | boolean | `true` = the service owner's own endpoint, not an aggregator route (see §5) |
| `team` | string \| absent | The operating **team** behind this endpoint's host — `"BlockRun"` \| `"Merit"` \| `"Sponge"` \| `"Orthogonal"` \| `"Heurist"` (see §5). Absent when no known team runs the host. Mutually exclusive with `firstParty` (a host is either the owner's own = 1P, or a 3rd-party gateway = a team). |
| `modelParam` | `{ name, value }` | For shared multi-model endpoints: the param that selects *this* model |
| `needsApproval` | boolean | `true` = outward/irreversible/expensive — get human approval before calling (see §6.4) |
| `price` | `Price` | Per-backend price (same shape as `pricing` + `min`/`max`/`dynamic`/`source`) |
| `payment` | `{ protocols[], accepts[] }` | **The payment instructions** — see §3.4 |
| `inputSchema` / `outputSchema` | object \| null | JSON schemas when captured (often null — use `usage` instead) |
| `async` | `AsyncSpec` \| absent | Machine-readable async/poll descriptor for poll-based jobs (job-id path, poll URL template, poll cost) |
| `status` | string | `active` backends only, after filtering |

### 3.3 ServiceUsage (`service.usage`) — the gold

This block is written from a **real, successful paid call**. If you index nothing
else from the detail layer, index this.

| Field | Meaning |
|---|---|
| `status` | `"verified"` for all active services — it was called and it worked |
| `verifiedAt` | ISO date of the successful test |
| `resultPull` | `"sync"` (result in the response), `"poll"` (async — poll for it), `"siwx"` (free, identity-gated), `"none"` |
| `auth` | `"none"` or `"siwx"` (extra auth beyond payment) |
| `callShape` | One line: method + URL + body shape |
| `inputExample` | **A real request body that produced a real result** — copy/adapt this |
| `outputShape` | Where the result is in the response, e.g. `body.data[0].url`, `body.results[]` |
| `quirks` | Exact gotchas discovered during testing — **read these** |
| `guide` | 2–6 plain-English sentences: how to use it end to end |
| `costObservedUsd` | What the test **actually paid** (ground truth, beats the headline price) |
| `needsApproval` | Mirror of the outward/irreversible flag |
| `sessionFlow` | For session-based services: create-op → session id → SIWX action ops → close-op |

### 3.4 Payment (`backend.payment`)

```jsonc
"payment": {
  "protocols": ["x402"],
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",                                   // Base (CAIP-2)
      "amount": "100000",                                         // BASE UNITS, not dollars
      "asset":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",     // USDC on Base
      "payTo":  "0xe6B84a6f9d6fDD7a5acA168Aaad8FCe7f1918971",     // recipient
      "maxTimeoutSeconds": 300
    }
    // …often a Solana and/or Polygon option as well — pick the chain you hold funds on
  ]
}
```

Each item in `accepts[]` is one payment option (one chain/asset). Pick whichever
chain you can pay on.

**Critical: `amount` is in token base units, as a string — not USD.** USDC has
**6 decimals**, so `"100000"` = 0.10 USDC = $0.10, `"30000"` = $0.03. Convert with
`amount / 10**decimals`. The human-readable price is in `pricing` / `price`.

**Common networks & USDC addresses:**

| `network` (CAIP-2) | Chain | USDC asset address |
|---|---|---|
| `eip155:8453` | Base (most common) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `eip155:137` | Polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (SPL) |
| `eip155:1` / `eip155:42161` / … | Ethereum / Arbitrum / long tail | per-entry |

> **Normalization quirk:** most entries use CAIP-2 (`eip155:8453`), but a minority use
> short names (`"base"`, `"solana"`). Normalize both when indexing: treat
> `eip155:8453` and `base` as the same chain.

---

## 4. Knowing which services "work"

The registry is already filtered for you — but here's how the signal is encoded:

- **`service.status === "active"`** → it's in the served catalog. (The API never
  returns anything else; in the raw files, everything else is `hidden`.)
- **`service.usage.status === "verified"`** → it was actually called and paid, and it
  returned a real result. **All 426 active services are verified.**
- **`service.usage.verifiedAt`** → when that happened.
- **`service.usage.costObservedUsd`** → the real amount the test paid (trust this over
  the headline price if they differ; some providers bill slightly off their quote).

Hidden entries (in the raw files only) carry a `hiddenReason` — `dead`, `broken`,
`mpp`, `untested`, etc. They're the durable "do-not-retry" record. **Do not surface
them as working services.**

---

## 5. First-party providers (1P) & operating teams

Two independent, host-derived tags tell you **who runs an endpoint**. They're mutually
exclusive on any one backend: a host is *either* the service owner's own (1P) *or* a
known third-party operator (a team).

### 5.1 First-party (`backend.firstParty`)

`backend.firstParty: true` means the backend is the **service owner's own endpoint**
(e.g. `api.exa.ai`), not a third-party aggregator route reselling it. In the active
set: **149 first-party backends across 144 services.**

- A service can have both: e.g. **Exa** has a first-party backend (`api.exa.ai/search`,
  ~$0.007) *and* aggregator backends (`blockrun.ai`, `stableenrich.dev`, ~$0.01).
  Backends are sorted first-party-first, so `backends[0]` is the first-party/cheapest.
- To prefer first-party when indexing: pick the backend where `firstParty === true`;
  fall back to `backends[0]`.
- `first-party.json` is the source map (provider aliases → owned hosts) used to stamp
  the flag. You don't need it at runtime — the flag is already on each backend — but
  it's there if you want to audit the derivation.

### 5.2 Operating teams (`backend.team`)

`backend.team` names the **third-party operator** that runs the endpoint's host — a
gateway/provider that fronts (and is paid for) the call, regardless of which underlying
model/service it serves. It is the operator of the HOST, not the model (e.g. BlockRun
fronts GPT-Image, Nano-Banana, Seedance — all tagged `BlockRun`). Use it to trust- or
quality-rank by operator. Derived from the host by `scripts/registry/teams.mjs` — stamped on **both** `backends[]` and `operations[]` (some teams, e.g. Heurist, expose their tools as a service's `operations[]` rather than backends).

| Team | Hosts | Served backends |
|---|---|---|
| **BlockRun** | `blockrun.ai` (+ their `*.run.app` infra) | ~66 |
| **Merit** | the whole `stable*` family on `.dev`/`.io` (`stableenrich.dev`, `stablestudio.dev`, `stablephone.dev`, …) | ~143 |
| **Sponge** | `*.paysponge.com` (incl. `*.x402.paysponge.com` subdomains) | ~31 |
| **Orthogonal** | `orth.sh` (incl. `x402.orth.sh`) + `orthogonal.com` | ~51 |
| **Heurist** | `mesh.heurist.xyz` / `heurist.ai` (Heurist Mesh agent gateway, ~23 agents) | ~73 ops |

- A service can span multiple teams (one backend each): e.g. **Exa** = a 1P `api.exa.ai`
  backend **+** a `BlockRun` backend **+** a `Merit` (`stableenrich.dev`) backend.
- `team` is absent on a backend whose host none of the known teams operates.
- **Mutually exclusive with `firstParty`:** a 1P backend has no `team`; a team backend is
  never `firstParty`. A model name (e.g. "GPT Image 2") is the *service*, never a team.

### 5.3 Filtering the registry by 1P / team

- **Per backend (detail layer, `GET /api/subcat/{slug}` or `by-subcat/*.json`):** filter
  `service.backends[]` by `b.firstParty === true` or `b.team === "Sponge"` (etc.).
- **Per service (summary layer, `GET /api/catalog` or `index.json`):** each `EntrySummary`
  carries **`teams: string[]`** = the distinct operating teams across that service's
  endpoints (e.g. `["BlockRun","Merit"]`; omitted when none). Filter the catalog without
  fetching detail — e.g. "all Sponge services" = `entries.filter(e => e.teams?.includes("Sponge"))`.
  (1P isn't pre-rolled onto the summary; for a 1P filter, read the detail layer.)

Both tags are **derived at build time** (`curate.mjs` stamps `firstParty` from
`first-party.json` and `team` from `teams.mjs`), so they're already baked into the served
JSON — no extra lookup needed at runtime. To add a new owner edit `first-party.json`
(via `gen-first-party.mjs`/`first-party-extra.json`); to add a new operating team edit
`teams.mjs`, then re-run `apply-teams.mjs`.

---

## 6. How to actually call & pay for a service

Three auth modes; the field is `backend.authMode`.

### 6.1 `x402` — pay-per-call (the default, 506 backends)

Standard [x402](https://x402.org) flow:

1. Make the request to `backend.url` with `backend.method` and a JSON body modeled on
   `usage.inputExample`.
2. The server replies **HTTP 402** with a payment challenge (the same data you see in
   `payment.accepts`).
3. Pay the `amount` (base units) of `asset` to `payTo` on `network`, attach the
   payment proof header, and retry.
4. You get the result. For `resultPull: "sync"`, it's in the response body at
   `usage.outputShape`.

Any standard x402 client library handles steps 2–4 automatically. The `accepts` data
in the registry is exactly what the server will challenge with, so you can pre-compute
cost and pick your chain before calling.

### 6.2 `siwx` — free, wallet-identity (Sign-In With X)

`authMode: "siwx"` / `usage.auth: "siwx"`: there's **no payment** — you sign a wallet
identity challenge instead, and the call settles **free ($0)**. `accepts[]` may be
empty. Results are typically scoped to the calling wallet identity. (Example: *Honcho
Agent Memory* — returns `body.messages[]` for your identity, empty array if none.)

### 6.3 `poll` / async result delivery (44 services)

`usage.resultPull: "poll"` means the first call returns a **job**, not the result:

1. `POST` returns `202` with a job id and a `poll_url` (often relative).
2. **Poll** the `poll_url` until `status: "completed"`, then read the result at
   `usage.outputShape`.
3. ⚠️ **Polling can cost money.** Many poll endpoints enforce their *own* x402
   challenge per poll, signed by the **same wallet** that did the submit. Budget for
   it: e.g. *GPT Image 1* costs ~$0.021 to submit **plus** ~$0.021 per completing poll
   (≈$0.042 total). The machine-readable `backend.async` block (when present) gives the
   `jobIdPath`, `pollUrlTemplate`, and `poll.cost` so you can automate this.

### 6.4 `needsApproval` — outward / irreversible (20 services)

`usage.needsApproval: true` (or `backend.needsApproval`) marks services that **do
something real and irreversible**: register a domain, send an email, place an order,
buy a phone number, publish content. These often cost real money ($5–$150) and **must
not be auto-executed.** Gate them behind explicit human confirmation. Example:
*StableDomains* registers a real Route53 domain for $20–$150 — its quirks tell you to
call `/api/check` first and only register with approval.

---

## 7. The catalog map (active services by category)

Use this to decide which subcategory slugs to pull. Slug = the `{slug}` in
`/api/subcat/{slug}` and the `by-subcat/{slug}.json` filename.

| Category (slug) | Active | Top subcategories (active count) |
|---|---:|---|
| **Data & Intelligence** (`data-intelligence`) | 161 | flight-aviation 37, crypto-blockchain-data 36, stocks-financial-data 18, company-people-data 16, maps-geolocation 15, social-media-data 12, news-media 8, weather 8, traffic-transportation 5, seo-keywords 3, trends-sentiment 3 |
| **AI & Machine Learning** (`ai-ml`) | 57 | llm-chat-apis 32, nlp-text-analysis 8, translation 7, vision-image-recognition 5, content-moderation 3, embeddings-vector 2 |
| **Media** (`media`) | 36 | image-generation 19, video-generation 8, music-generation 3, voice-tts 3, avatars-digital-humans 1, sound-effects-audio 1, speech-to-text 1 |
| **Search** (`search`) | 33 | ai-semantic-search 11, serp-seo-apis 11, web-search-apis 11 |
| **Web Automation** (`web-automation`) | 28 | web-scraping 9, web-crawling 8, screenshot-rendering 6, headless-browsers 5 |
| **eCommerce** (`ecommerce`) | 21 | tax-compliance 14, storefront-commerce-apis 5, shipping-logistics 2 |
| **Scheduling & Calendars** (`scheduling-calendars`) | 17 | scheduling-booking 14, cron-job-scheduling 3 |
| **Maps & Location** (`maps-location`) | 9 | ip-geolocation 5, address-validation 4 |
| **Payments & Billing** (`payments-billing`) | 9 | payment-processing 8, invoicing 1 |
| **Image & Video Processing** (`image-video-processing`) | 8 | image-editing-manipulation 4, video-editing-transcoding 2, image-video-cdn 1, transcription-subtitles 1 |
| **Document & Content** (`document-content`) | 8 | ocr-document-extraction 4, pdf-generation-processing 4 |
| **Communication** (`communication`) | 8 | sms-phone 5, email 2, video-voice-calls 1 |
| **Analytics & BI** (`analytics-bi`) | 8 | product-analytics 7, web-analytics 1 |
| **Infrastructure** (`infrastructure`) | 7 | dns-domain-management 3, sandbox-environments 3, app-hosting-paas 1 |
| **Database & Storage** (`database-storage`) | 5 | object-file-storage 4, decentralized-ipfs 1 |
| **Auth & Identity** (`auth-identity`) | 5 | identity-verification-kyc 5 |
| **DevTools & Observability** (`devtools-observability`) | 4 | uptime-status-pages 3, testing-qa 1 |
| **Security** (`security`) | 1 | captcha-bot-protection 1 |
| **Forms & Surveys** (`forms-surveys`) | 1 | survey-feedback 1 |

The live `/api/catalog` response carries the authoritative tree (`categories[]` with
recomputed active counts) plus every summary entry, so you don't have to hardcode this.

---

## 8. Worked example (a real active entry, trimmed)

`GET /api/subcat/ai-semantic-search` → the **Exa** entry:

```jsonc
{
  "id": "exa",
  "kind": "api",
  "name": "Exa",
  "provider": "exa",
  "category": "search",
  "subcategory": "ai-semantic-search",
  "pricing": { "headline": "$0.0070", "amount": 0.007, "currency": "USD", "unit": "per search" },
  "modality": { "input": ["text"], "output": ["json"] },
  "backends": [
    {
      "provider": "exa",
      "url": "https://api.exa.ai/search",
      "method": "POST",
      "authMode": "x402",
      "firstParty": true,                                   // ← owner's own endpoint, cheapest
      "payment": {
        "protocols": ["x402"],
        "accepts": [{
          "network": "eip155:8453",                         // Base
          "amount": "7000",                                 // 7000 base units = $0.007 USDC
          "asset":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "payTo":  "0x6d6E695b09861467c7d462f5AAF31cF3540B9192"
        }]
      },
      "status": "active"
    }
    // … 2 aggregator backends (blockrun, stableenrich) at ~$0.01 follow
  ],
  "usage": {
    "status": "verified",
    "verifiedAt": "2026-06-10",
    "resultPull": "sync",
    "auth": "none",
    "callShape": "POST https://api.exa.ai/search with JSON {query} (optional numResults, type, category)",
    "inputExample": { "query": "latest research on AI agent memory", "numResults": 5 },
    "outputShape": "body.results[].{id,title,url,publishedDate,author,score}; body.requestId",
    "quirks": [
      "Required field is `query`. Optional: numResults, type ('neural'|'keyword'|'auto'), includeDomains…",
      "This is SEARCH → ranked results[], NOT a synthesized answer (use Exa Answer for that).",
      "Default is first-party api.exa.ai (~$0.007); aggregator routes are ~$0.01.",
      "Pass {\"contents\":{\"text\":true}} to also get results[].text (may raise price)."
    ],
    "guide": "POST https://api.exa.ai/search with {\"query\":\"…\",\"numResults\":5}. Keyless x402 (~$0.007 USDC on Base). Synchronous JSON: read body.results[].",
    "costObservedUsd": 0.007
  },
  "status": "active"
}
```

Everything you need to call and pay is right there: endpoint (`backends[0].url`),
method, chain + asset + amount + recipient (`accepts[0]`), a working body
(`usage.inputExample`), where the answer is (`usage.outputShape`), the real cost
(`usage.costObservedUsd`), and the gotchas (`usage.quirks`).

---

## 9. Quick-start: mirror the registry in your system

```text
1. GET https://masterkey.sh/api/catalog
   → store `entries[]` as your service catalog (all 426 active; already filtered).
   → collect the set of subcategory slugs from entries[].subcategory (or categories[]).

2. For each slug (≈60), GET https://masterkey.sh/api/subcat/{slug}
   → for each Service: store backends[], payment.accepts[], and usage{}.
   → keep ≤60 req/min to stay under the rate limit.

3. Index for search on: name, aka[], tags[], provider, description.

4. Persist the call/pay essentials per service:
   - endpoint   = backends[0].url (+ .method)
   - auth       = backends[0].authMode  (x402 | siwx | paid)
   - price      = pricing.amount / usage.costObservedUsd
   - pay        = backends[0].payment.accepts[] (network, asset, amount-in-base-units, payTo)
   - call       = usage.inputExample (request body), usage.outputShape (result path)
   - first-party= backends.find(b => b.firstParty)
   - flags      = usage.resultPull (sync/poll), usage.needsApproval

5. Re-pull periodically (catalog `syncedAt` tells you the last build date).
```

---

## 10. Gotchas checklist (read before you index)

- **`accepts[].amount` is base units, not dollars.** Divide by `10**decimals` (USDC = 6).
- **`network` comes in two forms** — CAIP-2 (`eip155:8453`) and short (`base`).
  Normalize.
- **Trust `usage.costObservedUsd`** over the headline price when they differ.
- **`kind: "model"` may have several `backends[]`** — same model, different gateways.
  Pick first-party/`backends[0]` or pin a `providerId`.
- **`resultPull: "poll"` jobs can charge per poll** — budget extra (see §6.3).
- **`needsApproval: true` = real-world side effects** — never auto-execute (see §6.4).
- **The detail layer is the moat** — `usage`, `inputExample`, payment routing were
  earned by paying for live tests. Keep it confidential.
- **Raw files include hidden entries; the API doesn't.** Filter `status === "active"`
  if you ingest files directly.
- **`syncedAt`** (in `/api/catalog`, `index.json`, `meta.json`) is your freshness
  marker — re-pull when it advances.
```
