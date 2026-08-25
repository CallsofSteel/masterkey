# Registry Indexing Playbook — adding discovered endpoints, once, correctly

_How a URL found by discovery becomes a registry entry with the same depth as every existing one._
_Companion to `REGISTRY_DISCOVERY_GUIDE.md` (which ends where this begins) and `MASTERKEY_HANDOFF.md §5.5`
(the rules this enforces). Method built, validated on real money, and proven across 2 live batches
(2026-07-30): registry **823 → 831**, every write additivity-proven, all gates green._

> ⚠️ The earlier `add-discovered.mjs` single-script flow is **superseded and not used** — its probe silently
> dropped live endpoints (wrong method) and wrote null prices (`maxAmountRequired`), and the owner did not
> trust it. The method below replaces it. `add-discovered.mjs` remains only as a footnote in history.

---

## 🆕 2026-07-30 PIPELINE UPDATE (read first — supersedes the funnel/pre-filter details below)

The discovery funnel was rebuilt to carry the rich data it was silently dropping (commits `cd22506`+`57c8fb1`):
- **Sources:** CDP **Bazaar** (public, 15,527 resources, returns per-endpoint `accepts` + input/output examples
  + JSON schema + tags + traction) + **agentcash** (traction/protocols). **`x402-search` is our DEPRECATED
  aggregator — not a source.** Regenerate via `discover-new.mjs --mode=deep` (+ `discover-agentcash.mts`) →
  `consolidate-funnel.mjs`.
- **Rich funnel:** `data/registry/discovery/funnel-202607310043.json` — 29,453 fresh endpoints, **48% carry
  accepts + bazaar schema/examples**, ~13.4k payable ≤$0.25 derivable with **no probe**.
- **Front door:** **`scripts/registry/next-provider-batch.mjs --auto`** (highest-TRACTION fresh host) or
  `--host=<substr>` — reads `funnel.batches` (NOT `nameCollisions` — that was the old reader bug), excludes
  ever-terminal ledger URLs, derives price from bazaar, emits fan-out args with a `callHint` per endpoint.
- So Step-1 (pre-filter probe) below is now **optional** — only the no-bazaar-price rows still need a live
  probe. The **live 402 re-capture + pay-verify at INDEX time stays authoritative** (§5.5C; bazaar accepts are
  a hint). Model stays **Opus** (Sonnet+Haiku both tested + rejected — accuracy regressed).

---

## The shape of the method

**Deterministic core does everything that touches money or the registry, serially and provably.
A capable agent does the per-endpoint judgment a script must not fake.** (Owner-approved "hybrid".)

```
  ┌ 1. PRE-FILTER (free, deterministic) ──────────────────────────────────────┐
  │ index-endpoints.mjs --probe-only  →  probe each endpoint, keep payable≤cap │
  └───────────────────────────────────────────────────────────────────────────┘
              ↓  shortlist of payable endpoints (agents run ONLY on these — efficiency)
  ┌ 2. AGENT FAN-OUT (money, one capable agent per endpoint/provider) ─────────┐
  │ a Workflow: consult the index · find the correct call from the docs ·      │
  │ pay ONCE ≤$0.25 · handle async (poll) · defer what it can't satisfy ·      │
  │ HOLD merges · write a complete proposal to discovery/proposals/<slug>.json │
  └───────────────────────────────────────────────────────────────────────────┘
              ↓  proposals (verified / deferred), never an auto-import
  ┌ 3. SERIAL WRITE RAIL (writes the registry, additively, provably) ──────────┐
  │ apply-proposals.mjs --apply  →  curate.mjs  →  verify gates  →  commit      │
  └───────────────────────────────────────────────────────────────────────────┘
```

Nothing crosses a boundary implicitly. Pre-filter is free. Agents pay (per-call `--cap=0.25`, the only
bound — no cumulative ceiling; we control spend by keeping batches small). Only the write rail mutates the
registry, and it proves additivity every time.

---

## Run it

```bash
# 0. Build a synthetic single-batch funnel from the real 50,486-endpoint funnel (real funnel untouched).
#    Pick a coherent slice — ONE provider (best), or a set of served-provider endpoints. Exclude money-movers
#    (commit/checkout/order/send/pay/withdraw/transfer/refund/delete/buy/fund) and {path placeholders}.
jq '<select endpoints>' data/registry/discovery/funnel-202607292203.json > data/registry/discovery/funnel-batch-X.json

# 1. FREE pre-filter → shortlist of payable≤cap (defers over-cap / unreachable / needs-accepts, rejects non-402)
node scripts/registry/index-endpoints.mjs --funnel=data/registry/discovery/funnel-batch-X.json --batch=1 --probe-only

# 2. MONEY — fan out one agent per payable endpoint via the Workflow tool (see "The agent" below).
#    Pass the shortlist's `payable[]` (+ provider context) as args. Each agent writes discovery/proposals/<slug>.json.

# 3. Apply (dry first), then for real; curate each touched subcat; verify; prove additivity; commit.
node scripts/registry/apply-proposals.mjs --dir=data/registry/discovery/proposals            # DRY
node scripts/registry/apply-proposals.mjs --dir=data/registry/discovery/proposals --apply
node scripts/registry/curate.mjs --subcat=<each touched subcat>
node scripts/registry/verify-drift.mjs && node scripts/registry/verify-no-tangle.mjs && node scripts/registry/verify-bundle-pins.mjs
```

**Prove additivity** (the load-bearing guarantee): `shasum -a 256` every `curation/*.json` + `by-subcat/*.json`
+ `index.json` + `meta.json` before and after; diff must show ONLY the touched subcats' files + index/meta.
Then move applied proposals to `discovery/proposals/done/` so a re-run can't collide.

---

## The three tools (all trustworthy — reused, not the distrusted script)

| Tool | Role | Key guarantees |
|---|---|---|
| `index-endpoints.mjs --probe-only` | Pre-filter (free) | Probe with **method fallback GET↔POST** (funnel methods are wrong ~half the time); price from **`maxAmountRequired ?? amount`**, USDC-aware; network/DNS error → `unreachable` (retryable, NOT rejected); 402-with-no-accepts → `needs-accepts`; over-cap → deferred. Resumable checklist. **UPGRADED 2026-07-30 (#1-#3, commit `231b547`):** probes in PARALLEL (×12) with a hard `Promise.race` timeout + a per-host reachability precheck (a dead/hanging host is skipped in ~8s, not 40 min); prefers **POST when >1 method yields a 402** (fixes POST-execute providers like stratalize); **deterministically dedups** exact-dup URLs + version/prefix aliases (`/api/x`≡`/api/v1/x`≡`/x`) → `duplicate`, never sent to an agent or paid; emits a per-endpoint **`callHint`** (method + openapi example/schema/summary). |
| The **Workflow** (agent fan-out) | Judgment + pay (money) | One `general-purpose` agent per endpoint. Consults the index, reads openapi.json/llms.txt/402-`outputSchema.input` for the correct call, **prefers the provider's documented example inputs**, pays ONCE via `dist/qa-pay.mjs --cap=0.25`, handles async (pay create → poll free/SIWX get → result), defers cleanly, **holds merges**, writes a complete proposal. |
| `apply-proposals.mjs` | Serial write rail | Applies only `decision:"verified"` + **field-complete** proposals, ADDITIVELY, with a **byte-identical assert** on every pre-existing entry (restore + abort on drift), slug-collisions **FATAL**, existing-subcat-only, **merge-candidates HELD** (never auto-applied). |

Reused verified primitives: **`dist/qa-pay.mjs`** (money-safe: unpaid-quote-before-pay, per-call cap enforced
pre-settlement, `requireChallenge` so a non-402 never pays, real `X-Payment-Response` settlement); **`curate.mjs`**
(projection; now stamps `syncedAt` = build time, fixed); the three **verify gates**.

> ⚠️ **openapi / `callHint` is BEST-EFFORT and OPTIONAL — the pipeline NEVER relies on it (verified 2026-07-30).**
> The live 402 probe is the source of truth for price + `accepts`; openapi only *hints* the call shape to save
> a wasted paid 400. `hostSpec()` is a try/catch that returns `null` on any failure, so a missing/broken/huge
> openapi can't crash or stall the pre-filter. When a host serves no openapi (or one with no example), the
> `callHint` is empty, the fan-out prompt DROPS the hint line, and the agent self-discovers the call exactly as
> before — **no regression**. Do NOT add any step that requires openapi to exist. (Most x402 hosts do serve one
> by convention, but treat it as a bonus, never a dependency. When it carries a real request *example*, the
> agent pays directly and skips discovery — that's the only case where `callHint` cuts agent tokens; a
> summary-only openapi just orients, so per-agent cost stays flat.) When building Workflow args, pass `callHint`
> through per endpoint (`callHint: r.callHint`); the prompt already consumes it and no-ops when it's empty.

---

## The agent (the per-endpoint brief — this is the moat)

Each agent gets one endpoint (+ its pre-captured accepts/price + provider context) and MUST:
- **Consult the index** — grep `scripts/registry/curation/*.json` for existing entries. A **new model/op**
  → its own service `"Brand Operation"`. The **same model/op via a different provider/host** (e.g. this host
  resells a model we already list) → set `mergeCandidate` to that existing service's exact name **only with
  evidence** the underlying model matches (the response reveals it — never guess); `apply-proposals.mjs`
  auto-folds it as a new backend (its own url/price/schema). **Never index half a service** — if using it
  requires a companion (a free result/status endpoint), capture that.
- **Collapse path-param proliferation** — if this endpoint's URL differs from sibling endpoints ONLY by a
  value in one path segment (same op, that segment is an INPUT: `/signal/BTC` vs `/signal/SOL`;
  `/crypto/price/avax` vs `/sol`; `/arena/{strategy}/BTC` vs `/ETH`) → it's ONE **templated** service
  (`/signal/{symbol}`), NOT one-per-value. (Distinguish real distinct ops like `/aviation/flight` vs
  `/flight-status` — don't collapse those.) In a parallel fan-out with no coordination, use a deterministic
  canonical: **index the templated service ONLY IF your value is alphabetically first among the siblings;
  else defer as `duplicate` WITHOUT paying** (this also stops redundant per-value spend). Registry supports
  `{param}` URLs (ChainRay `/address-report/{address}`); `run.ts buildRequest` substitutes `{curly}`/`:colon`.
  (If it slips through and per-value dupes reach apply, collapse manually: keep one, retarget its url to
  `{param}`, record the rest as `duplicate` — as done for signalfuse/x402node this session.)
- **Free endpoints:** if it's a free 2xx (no 402), NEVER attempt payment. Index it (when useful / part of a
  service) with `amount:0`, `payment.protocols:["free"]`, `accepts:[]`, `usage.auth:"free"`,
  `usage.costObservedUsd:0`. Never fabricate a `$0` accept or `payTo`.
- **Find the real call** from openapi.json / llms.txt / the 402 `outputSchema.input` — query vs body vs path.
- **Prefer the provider's OWN documented example values.** A guessed input can buy an HTTP 400 that still
  costs money (we lost $0.054 on a guessed `company_name` when the schema documented a working `business_id`).
- **Pay ONCE, only with a real valid input.** No input we have → defer `needs-input`, don't pay. Async → pay
  create, poll the free/SIWX status endpoint for the real result, document the flow.
- **Match the exact entry shape** (read 1–2 existing entries in the target subcat). Modality vocab is
  `text|json|image|video|audio|code|vector` (**`json` is valid**; a data output is `json`, not `text`; there is
  no `file`). **Never set `firstParty`/`team`** — `curate.mjs` derives them by host.

The batch-B Workflow (`data/registry/discovery/` transcript) is the reference implementation; adapt its
`promptFor()` per batch.

---

## What lands in the registry (the entry shape)

```jsonc
{ "name": "CoinStats Global Market Data",   // Brand + Operation, brand from the HOST
  "kind": "api",                            // "model" if it runs a named AI model
  "provider": "CoinStats", "providerId": "coinstats",
  "aka": ["coinstats-global-market-data", …],
  "description": "…",                        // one sentence, what it does + what you get back; never empty
  "tags": ["crypto","market-data",…],        // 3-6, never empty
  "modality": { "input": ["text"], "output": ["json"] },   // real vocab only
  "backends": [{
    "url": "…", "method": "GET", "provider": "…", "providerId": "…",
    "amount": 0.001,
    "accepts": [ … ],        // §5.5C — from the LIVE 402, header AND body; maxAmountRequired normalized to amount
    "probe": { "status": 402, "method": "GET", "payable": true, "checkedAt": "…" },
    "inputSchema": { … }, "outputSchema": { … }
  }],
  "usage": {
    "status": "verified",    // only when the paid call returned <400 (or an async submit 200 + polled result)
    "verifiedAt": "…", "resultPull": "sync",   // "poll" for async
    "auth": "none", "callShape": "…", "inputExample": {…},
    "outputShape": "…",      // the REAL captured response
    "quirks": [ … ],         // OBSERVED only (charge-then-error, async job id, precondition) — [] when nothing unusual
    "needs": [], "needsApproval": false,
    "guide": "…", "costObservedUsd": 0.001
  },
  "status": "active" }
```

`category`/`subcategory` are **NOT** entry fields — they live on the curation file header. Placement decides
which file the entry is written into. Allowed placements = the **existing curation files** (filename ==
`subcategory`), NOT the drifted `taxonomy.txt`.

---

## The states, and the "nothing is lost" guarantee

```
todo → probed → judged → paid → applied
           ↓        ↓
  deferred-over-cap · unreachable · needs-accepts · needs-classification · needs-input · rejected · (held-for-merge)
```

Everything above the cap, unreachable, needing an input we lack, or flagged as a possible merge is **parked
on the checklist / in a held proposal with its reason — never dropped**. `deferred-over-cap` keeps its price
so you can re-collect it with a higher cap. The write rail asserts every row is in a known state.

---

## Money safety

- Per-call `--cap=0.25` (owner: enough because we batch; no cumulative ceiling).
- `dist/qa-pay.mjs` takes an **unpaid quote first** and throws **before paying** if the quote exceeds the cap;
  `requireChallenge` means a non-402 endpoint never pays.
- Agents pay **at most once** per endpoint. A paid call that 400s is NOT retried (recorded + deferred).
- Every settled charge is logged to `data/registry/qa-spend-log.jsonl` — trust the log + on-chain delta, not
  agent self-reports. (Seen once: an unconfirmed first attempt + a confirmed retry on one async endpoint; the
  reconciler voids unconfirmed rows.)
- ⚠️ `QA_SPRINT_CEILING`/`QA_SPRINT_PREFIX` is a cumulative backstop **only if every pay passes `--label=<prefix>`**
  (the old `add-discovered.mjs` passed none, so its ceiling never accrued). The default prefix already holds
  ~$210 of history — use a fresh prefix if you wire it.

---

## Policies (owner-decided) + one open refinement

1. **Service = model/capability + operation; each provider = a backend (§5.5A) — BUILT, automatic.** When an
   endpoint provides the SAME model/op as an existing service (even from a different host — e.g. 2s.io running
   Deepgram Nova, which we already list via Sponge), the agent sets `mergeCandidate` to that service's name
   **with evidence** (the response reveals the underlying model — don't guess). `apply-proposals.mjs` then
   **folds it as a new backend** on that service: it resolves the target by name across all curation files and
   appends the backend (its OWN url/price/accepts/schema) additively, asserting every pre-existing entry is
   intact and the target only GAINED backends (restore+abort otherwise). An unresolved target is HELD, never
   fabricated. A NEW model/op (blockrun gpt-5.4 vs gpt-5.5) → its own service. The **tangle** to avoid is
   assuming providers share a path/base URL — they never do; each backend keeps its own url + schema.
   (Done live: Deepgram Nova gained a 2s backend; auor Maps gained its /search/basic tier.)
2. **Free endpoints — DECIDED: mark `free`, agents NEVER attempt a $0 payment.** Agents already never pay a
   free endpoint (`qa-pay` only pays a real 402; a free 2xx passes through). Index a free endpoint when it is
   part of a useful service (owner: don't index half a service — e.g. AgentMail paid send + free inbox-read).
   Representation: `backends[].amount: 0`, `payment.protocols: ["free"]` (NOT `["x402"]`, so
   `verify-no-tangle` doesn't flag it as an unpayable x402 backend), `accepts: []`, `usage.auth: "free"`,
   `usage.costObservedUsd: 0`. Do NOT fabricate a `$0` accept or a `payTo`. (Confirm the served-free fetch
   path in `run.ts` the first time one ships.)
3. **Companion-chains (open refinement).** An endpoint needing a prior call's output (e.g. Stableflare Image
   Transform needs an `image_id` from a paid upload) can't be pay-verified by an isolated parallel agent — it
   correctly defers. A sequential provider-agent (one agent handling the whole provider flow) can chain and
   verify these; adopt it for providers with companion chains.

---

## Proof this works (2026-07-30)

Validation + batch-A (7 served-provider endpoints) + batch-B (stableflare.dev, provider-coherent, async).
**+8 verified services, 823 → 831**, ~$0.58 spent, all per-call ≤$0.25, every batch additivity-proven
(only expected files changed), all verify gates green, `tsc` clean. Commits `5760dd4`, `12e5612`, `d23f40d`.

Behaviors demonstrated: method-fallback recovered a live endpoint the funnel mis-methoded; `maxAmountRequired`
priced an endpoint the old script null-priced; charge-then-error caught + deferred (no thrashing); async
create→poll→result captured; merge candidates held; incomplete/empty-field proposals refused; provenance
`teams:null` (not guessed); companion-chain deferred honestly.
