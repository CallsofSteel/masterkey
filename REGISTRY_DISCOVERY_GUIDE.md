# Registry Discovery — refreshing & expanding the catalog

_How to find endpoints the x402 ecosystem has gained since we last indexed, and turn them into registry
entries with the same depth as the existing ones — without ever risking what we already paid to learn._

**Read this before running any discovery script.** Last updated 2026-07-29.

---

## The goal, in one paragraph

Our registry's value is not the URL list. Anyone can scrape URLs. The value is the **pay-tested layer**:
797 `usage` blocks across 832 curation entries — real prices, call shapes, output shapes, async/SIWX flows,
charge-then-fail traps. We spent real money learning those. Discovery exists to feed that pipeline with new
raw material, never to overwrite it.

So the pipeline is a **funnel with a one-way valve**:

```
  ┌─ TOP OF FUNNEL ──────────────────────────────────────────────────┐
  │ 1. AGGREGATE   pull every endpoint the discovery indexes know    │  free
  │ 2. SUBTRACT    remove everything we already have, in any state   │  free
  │ 3. ENRICH      ask each host to describe itself (specs, guidance)│  free
  └──────────────────────────────────────────────────────────────────┘
                              ↓  a reviewed list, never an auto-import
  ┌─ THE EXPENSIVE PART ─────────────────────────────────────────────┐
  │ 4. PAY-TEST    call it for real, once, and observe what happens  │  costs money
  │ 5. CURATE      write the entry + usage block into curation/      │  human judgment
  └──────────────────────────────────────────────────────────────────┘
```

Steps 1–3 are automated and safe. Steps 4–5 are deliberate, cost money, and are where the moat is built.
**Nothing crosses from 3 to 4 automatically.**

---

## What each step actually KNOWS — and why we still probe (verified 2026-07-30)

A fair question: "the aggregator scrape already found these — didn't it give us price/description/schema so we
can skip probing?" **No.** Measured against our own dumps:

- **The discovery source (`x402-search.vercel.app`) is a DIRECTORY, not a data sheet.** The funnel
  (`funnel-*.json`) is **bare URL strings**. `agentcash-index-*.json` is **origin-level** (provider, title,
  description, protocols) — 2,808 *providers*, not per-endpoint rows. `new-endpoints-*.json` is `{key, name}`.
  Across all of them: `withAccepts 0 · withPrice 0 · withInputSchema 0`. So the scrape tells us **what exists +
  a provider blurb** — never the per-endpoint payment requirements or the call shape.
- Therefore the pipeline probes for two different things, from two different sources, for two different reasons:
  1. **The live 402 probe is the ONLY source of `price` + `accepts`.** The scrape never had them, and the
     registry entry legally needs the captured `accepts` (§5.5C) + we need the price to check the $0.25 cap.
     This is not redundant re-work — it's the only place that data exists.
  2. **The host's openapi/llms.txt (step-3 ENRICH) gives the CALL SHAPE** — method, required params, a
     documented example — so the ONE paid verification call uses a valid input and doesn't buy a paid HTTP 400.
     This is "how to call it to protect money," NOT catalog metadata (name/description is guide-level and comes
     from the agent's judgment at curate time). **openapi is BEST-EFFORT and OPTIONAL** — see the note in
     `REGISTRY_INDEXING_PLAYBOOK.md`; when a host serves none, the agent self-discovers and nothing breaks.
- (Aside: the x402 **bazaar** does carry price+description per resource — that's its indexing requirement — but
  our funnel was built from the x402-search directory, which doesn't, so there was never bazaar-grade richness
  to reuse. If a future discovery pulls from bazaar, capture its price/accepts/schema at step 1 to skip probes.)

---

## 🛑 The five rules

1. **Discovery NEVER writes to the registry.** Not `data/registry/by-subcat/`, not `index.json`, not
   `meta.json`, not `scripts/registry/curation/`, not `candidates/`. `discover-new.mjs` enforces this in
   code via `assertWritable()`, not by convention. If you write a new discovery script, copy that guard.

2. **Never re-suggest a `hidden` entry.** `status:"hidden"` + `hiddenReason` is our memory of *"we paid to
   test this and it's broken"*. That's why the rule is **mark, never delete** (`CLAUDE.md`). Discovery
   loads hidden URLs into the known-set so they come back as `known-hidden`, not as fresh leads.
   Re-indexing them means paying twice to learn the same thing.

3. **Dedupe on the exact endpoint URL — nothing coarser.** Not by provider, not by capability. All three
   of these are things we WANT and must not filter out:
   - a new endpoint at a provider we already have (BlockRun ships something new)
   - a new provider offering a capability we already have (a second image generator)
   - a new provider offering something new

4. **Enumerate before you search.** A keyword index only contains what someone submitted with vocabulary
   you guessed. A host's own `/openapi.json` lists everything it actually serves. Measured: `2s.io`
   exposes 578 operations where the Bazaar listed 200.

5. **A discovery report is a list of LEADS, not findings.** Same discipline as `probe-staleness.mjs`: a
   host that didn't answer may be rate-limiting us, not dead. Never promote a lead to a registry entry
   without a real call.

---

## The sources, and what each is actually good for

| Source | Enumerates? | Auth | What it uniquely gives |
|---|---|---|---|
| **CDP Bazaar** | ✅ `/discovery/resources`, paginated | none | Breadth. 15,234 resources. The widest net. |
| **AgentCash** | ✅ per-origin `discoverOriginSchema` | wallet cfg | **Richest.** `trustTier`, provider-authored `guidance`, `authMode`, `pricingMode`, `protocols`. Summaries carry real gotchas. |
| **Orthogonal** | ✅ `/v1/list-endpoints`, one call | API key | 74 APIs / 876 endpoints with `queryParams`/`bodyParams` (name+type+required) — most of an input schema. |
| **x402-search** (ours) | ❌ search only | none | Fans ONE query to all six sources and merges. Reaches Zero + Wonderland, which have no enumeration API. |
| **Host `/openapi.json`** | ✅ per-host | none | Ground truth. Fallback `/.well-known/x402`. ~78% of real x402 hosts answer. |

**Prefer AgentCash over raw `/openapi.json`** where it covers the origin. Both read the same protocol, but
AgentCash returns a materially richer envelope. Raw OpenAPI is the fallback, not the default.

> ⚠️ `x402-search/package.json` lists `agentcash` while the code imports **`@agentcash/discovery`**. With a
> cold `node_modules` it won't resolve. Install `@agentcash/discovery` explicitly.

---

## Step by step

### Step 1 — sweep (free, ~40–60 min for everything)

```bash
node scripts/registry/discover-new.mjs --mode=all --concurrency=10
```

Modes: `deep` (Bazaar) · `orthogonal` · `search` (338-query taxonomy) · `depth` (per-host specs) ·
`both` (deep+search, quick) · `all`. Scope with `--host=<substring>` while iterating.

Report lands in `data/registry/discovery/new-endpoints-<stamp>.json` (gitignored). It separates:

- **`newAtVettedProviders`** — hosts we already serve. **Start here.** Trust, payment rail and quirks are
  already established, so indexing one is incremental rather than a fresh evaluation.
- **`newAtNewProviders`** — everything else. Needs trust triage first.

This split is *prioritization, not filtering*. Nothing is dropped.

### Step 2 — enrich with AgentCash (free)

Feed the sweep's host list through AgentCash for the richer envelope, then fold it back in:

```bash
# in ~/services/x402-search  (owns the dep + secrets; Masterkey stays clean)
npm i @agentcash/discovery
node --env-file=.env.local scripts/dump-agentcash-origins.mjs \
     --origins=hosts.txt --out=/tmp/agentcash.json

# back in masterkey
node scripts/registry/discover-new.mjs --import=/tmp/agentcash.json
```

### Step 3 — triage into batches

Do **not** try to swallow the whole list. Sort by the two buckets above, then by endpoints-per-host. The
distribution is extremely skewed — median host has ~2 endpoints, a handful have 500+. A giant unknown host
is usually one API wrapped into hundreds of routes; treat it as ONE decision, not 500.

### The funnel is already built

Steps 1–3 have been run. The consolidated worklist lives at
**`data/registry/discovery/funnel-202607292203.json`** (gitignored, 64 MB): **50,486 genuinely-new
endpoints**, deduped against the whole registry, grouped by host, its `accounting` block balanced. You do
**not** need to re-run discovery to start indexing — re-run it only to refresh (the AgentCash sweep is ~670
wallet-signed requests, so don't repeat it casually). Older per-source sweeps are kept for provenance.

### Steps 4–5 — pay-test + index → `REGISTRY_INDEXING_PLAYBOOK.md`

Discovery ends here. Turning a lead into a registry entry — at the same depth as every existing one, once,
additively, money-safe — is a **validated, separate pipeline**. Do NOT hand-edit curation from a raw lead
and do NOT bulk-import. **Read `REGISTRY_INDEXING_PLAYBOOK.md`** and run its three stages:

1. **Free pre-filter** — `index-endpoints.mjs --probe-only` over a synthetic single-batch funnel (a slice of
   the funnel above) → a shortlist of payable≤cap endpoints; defers over-cap / unreachable, rejects non-402.
2. **Agent fan-out** (money) — a Workflow spawns one capable agent per payable endpoint that consults the
   index, finds the correct call from the provider's docs, pays ONCE ≤$0.25, and writes a complete proposal.
3. **Serial write rail** — `apply-proposals.mjs --apply` (additive, byte-identical assert, merge-hold) →
   `curate.mjs` → the three verify gates → prove additivity → commit.

`payment-or-nothing` still holds (a live 402/SIWX or a free 2xx; drop anything needing an upstream API key),
and accepts are captured at index time from the live 402 — never a later backfill.

> ✅ `curate.mjs` now stamps `index.json`/`meta.json` `syncedAt` = the actual build time (fixed 2026-07-30).
> It previously read the candidate file's old `generatedAt` and could move "Last synced" backwards.

---

## Do / Don't

**Do**
- Run the whole funnel free before spending anything
- Start with new endpoints at providers you already serve
- Record `usage.needsApproval` during QA — the harness now reads it directly (`approval-rules.ts`), so a
  pay-test that finds an outward endpoint arms the approval gate with no second edit
- Re-run periodically; the ecosystem grew ~14k endpoints in roughly a month

**Don't**
- Don't hand-edit `data/registry/by-subcat/*.json` — generated, silently reverted by the next `curate`
- Don't delete a dead entry — hide it with a `hiddenReason`
- Don't trust a non-response as "dead" — re-verify serially before hiding
- Don't bulk-import a discovery report. Every entry in this registry was earned by a real call

---

## Where things live

| Thing | Path |
|---|---|
| Additive discovery sweep | `scripts/registry/discover-new.mjs` |
| AgentCash dumper | `~/services/x402-search/scripts/dump-agentcash-origins.mjs` |
| **Consolidated funnel (the worklist)** | `data/registry/discovery/funnel-202607292203.json` (gitignored) |
| Reports / proposals / checklist (gitignored) | `data/registry/discovery/` |
| Query taxonomy (338) | `scripts/registry/queries.mjs` |
| Curation source of truth | `scripts/registry/curation/` |
| **Indexing method (steps 4–5)** | **`REGISTRY_INDEXING_PLAYBOOK.md`** |
| **Pre-filter (free)** | `scripts/registry/index-endpoints.mjs --probe-only` |
| **Money-safe pay primitive** | `scripts/registry/dist/qa-pay.mjs` |
| **Serial write rail** | `scripts/registry/apply-proposals.mjs` |
| Verify gates | `verify-drift.mjs` · `verify-no-tangle.mjs` · `verify-bundle-pins.mjs` |
| Staleness sweep (existing entries) | `scripts/registry/probe-staleness.mjs` |
