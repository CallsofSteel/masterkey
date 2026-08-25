# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project Overview

MasterKey (package name `masterkey`) is a Fal-like, pay-per-use catalog of x402-compatible AI models and services — spanning media generation, voice, transcription, communication, data, sandboxes, and more. A person browses a category, finds the exact model/service they want, and uses it per call. The platform brokers each call over x402, but that plumbing is invisible to the everyday user (surfaced only in an "Advanced (technical)" section). Deployed at https://masterkey.sh.

The catalog is driven by a **curated registry** that MasterKey builds itself by discovering, probing, and curating real x402 services. The same registry serves both the human UI and a future agent-facing MCP — every entry is self-describing (how to call each backend, what it costs, the payment requirements).

`SPEC.md` is the source of truth for the v1 build (Service Registry + Catalog UI).

## Commands

```bash
npm run dev            # Start dev server at http://localhost:3000
npm run build          # Production build (Next 16 + Turbopack)
npm run lint           # ESLint
npm start              # Start production server
npm run registry:build # Discover/probe/report the registry pipeline (scripts/registry/run.mjs)
```

No test framework is configured.

## Architecture

> ⚠️ This is **not** a static-TypeScript catalog. There is no `allCategories`, no per-category `.ts` files, and no selection/JSON-copy flow. Catalog data lives in curated **JSON** read server-side and served through rate-limited API routes.

### The registry (server-only data — `data/registry/`)

The curated registry is the product's moat, so it is **NOT** under `public/` (that would be a one-curl static dump). It lives in a server-only `data/registry/` directory, committed to git, read by the Next.js server, and reachable only through rate-limited API routes:

```
data/registry/
  index.json              # manifest: category tree + counts + EntrySummary[] (summaries only — no backends/schemas) + syncedAt
  meta.json               # { syncedAt, totalServices, perSubcategory }
  by-subcat/<slug>.json   # full Service[] (incl. backends[] with url/method/schema/payment) for that subcategory
```

- A registry unit is a **`Service`** with a `kind` discriminator: `"model"` (one entry per AI model, usually served by one or more `backends[]`) or `"api"` (a multi-operation service with `operations[]`). A model served by several gateways → one `Service` with many `backends[]` (each backend = one gateway, with a `modelParam` selecting the model on a shared endpoint).
- Types are in `src/data/types.ts`: `Service`, `Backend`, `Operation`, `Price`, `PaymentOption`, `Probe`, `EntrySummary`, `RegistryIndex`, `CategoryNav`. This is the single source of truth for both the UI and the future MCP.
- Only endpoints callable with **payment-or-nothing** are kept — a live `402` (x402, incl. SIWX) or a free `2xx`. Endpoints needing an upstream API key / other auth are dropped. **MPP (Tempo / paywithlocus) is a different protocol and is excluded.**

### Serving & protection layer (`src/lib/registry.ts`, `src/app/api/`, `src/proxy.ts`)

- **`src/lib/registry.ts`** — server-only loader. `getIndex()` reads `index.json` (memory-cached in production; re-read in dev so rebuilds show up). `getSubcategory(slug)` reads `by-subcat/<slug>.json` on demand (Map-cached in prod; validates the slug against `^[a-z0-9-]+$` to block path traversal). Never import this from client code.
- **`GET /api/catalog`** (`src/app/api/catalog/route.ts`) — returns the manifest (`RegistryIndex`: category tree + summary entries + `syncedAt`). Summary-only; safe for browse/SEO/MCP.
- **`GET /api/subcat/[slug]`** (`src/app/api/subcat/[slug]/route.ts`) — returns full `Service[]` detail for one subcategory. This is the **only** path to backends/schemas/payment; there is deliberately no endpoint that dumps all detail at once.
- **`src/proxy.ts`** — Next 16's renamed Middleware. Upstash sliding-window rate limit (60 req/min/IP) on `matcher: "/api/:path*"`, returns `429` when exceeded. **Degrades gracefully**: if `masterkey_KV_REST_API_URL`/`_TOKEN` are absent (local dev), it no-ops.
- **`next.config.ts`** — `outputFileTracingIncludes` bundles `./data/registry/**/*.json` into the serverless function traces so route handlers can `fs`-read them in production.

### UI Layer (`src/app/`)

- **`page.tsx`** (server component) calls `getIndex()` and passes the manifest to the client `<Catalog index={...}>` in `catalog.tsx` as props — instant first paint, summaries SSR'd (public/fast/SEO-friendly).
- **`catalog.tsx`** (client) renders the Fal-like browse experience: an "All" search-first view + per-category grids, both running off the SSR'd `EntrySummary[]`. Opening a service lazy-fetches `GET /api/subcat/[slug]` for full detail (cached client-side in a `useRef` Map). The footer shows the **"Last synced"** date from `index.syncedAt`.
- The detail sheet (`DetailBody`) shows clean consumer fields plus a collapsible **"Advanced (technical)"** section: per-backend provider/url/method, input/output schema, payment requirements (protocols/networks/asset/payTo), `modelParam`, docs links.
- **Search** runs client-side via `useMemo` with developer-friendly alias expansion. No multi-select in v1 (a clean seam is left for future "bundling").

### Build pipeline (`scripts/registry/` — plain `.mjs`, run with `node`)

Claude is the curator; the scripts are instruments. They gather breadth and serialize curation decisions — they do not write entries from heuristics alone.

- **`run.mjs`** — orchestrator: discover (x402-search `/api/search` + `/api/discover`) → probe → classify → report. Flags `--category=<slug>`, `--all`, `--dry-run`, `--no-cache`, `--cap=N`.
- **`core.mjs`** — engine: cached fetch, search/discover, **probe** (browser User-Agent + documented-method-then-GET/POST fallback; a live `402` wins over a misleading label), per-asset **decimals** + price math, network normalization, **PSL-style hosting detection** (`*.vercel.app` etc. → `hosting:"platform"` → needs-review), name cleanup, internal/trivial path classification, `llms.txt` fetch.
- **`queries.mjs`** — `CATEGORIES` taxonomy + per-subcategory keyword queries.
- **`gateways.mjs`** — seed list of multi-model gateways to enumerate (keyword search misses these).
- **`curate.mjs`** — assembles `Service[]` for a subcat from `candidates/<slug>.json` + my `curation/<slug>.json` decisions (service `id = slug(name)`; the curation `id` field is legacy/ignored), then writes `by-subcat/<slug>.json` + rebuilds `index.json` + `meta.json`. **Auto-drops MPP backends** and prunes services with no payable x402 backend. `curation/` is re-applied every build, so human curation persists across syncs (idempotent).
- **⚠️ The shipped `data/registry/by-subcat/*.json` + `index.json` are GENERATED — never hand-edit them.** They are a pure projection of `curation/`. To add/change/hide a service: (1) edit `scripts/registry/curation/<subcat>.json` (upsert by `slug(name)`; set `status:"hidden"`+`hiddenReason` to hide), (2) `node scripts/registry/enrich-accepts-durable.mjs --subcat=<slug>` to backfill x402 `accepts` from a live 402 probe (writes to the SOURCE — curation/candidates), (3) `node scripts/registry/curate.mjs --subcat=<slug>`, (4) `node scripts/registry/verify-drift.mjs` + `verify-no-tangle.mjs`. A surgical by-subcat/index edit that skips curation is DRIFT — the next curate silently reverts it.
- **`enrich-accepts-durable.mjs`** — the accepts backfiller: re-probes live (fresh `402`) and writes `payment.accepts[]` to the SOURCE (`candidates/` for candidate-ref backends, the curation backend object for manual ones) so they survive a curate. `--subcat=<slug>` / `--all` / `--dry-run` / `--cap=N`. (The old `enrich-accepts.mjs` wrote to by-subcat → wiped on rebuild → **deprecated**, moved to `scripts/registry/_deprecated/`.)
- **🛑 NEVER DELETE A REGISTRY ENTRY — MARK IT.** A service/backend/operation we indexed and tested that stops working gets `status:"hidden"` + `hiddenReason` and STAYS in the stored file. That keeps "we tried it and it's dead" distinguishable from "we never indexed it", so we don't re-discover and re-pay-test the same dead endpoint forever. `registry.ts` filters hidden services, backends AND operations out of the served view.
- **`probe-staleness.mjs`** — READ-ONLY staleness sweep (unpaid probes; writes nothing; refuses to run without `--host`; skips free+mutating endpoints so it can't really send/delete anything). **🛑 Its output is a shortlist of LEADS, not findings — never go straight from a report to editing `curation/`.** It is ASYMMETRIC: `alive-*` is trustworthy (a response proves the route exists), but **DEAD / host-down / price-drift are NOT trustworthy alone** — absence of a good response also comes from our own concurrency, a blip, an unsubstituted `{placeholder}`, or throttling. Before hiding or re-pricing: (1) re-verify SERIALLY at concurrency 1, (2) corroborate with a second source (provider OpenAPI / llms.txt / its own error body). Two rules that caught real bugs: **one contradiction invalidates the run** (a host with both "host-down" and "alive" endpoints means the probe is wrong, not the host), and **a recurring round number ($10/$1/$20) is a worst-case ceiling for the synthetic probe body, not a price** — re-quote using the registry's own `usage.inputExample` before believing any drift. Full rationale + near-misses: the file header and the STALENESS bullet in `MASTERKEY_HANDOFF.md`.
- **`verify-drift.mjs`** (`npm run registry:verify-drift`) — guardrail: fails if any shipped by-subcat service's `status` disagrees with its curation projection (catches surgical by-subcat/index edits that bypass curation). Run after any curate; wire into CI.
- **`verify-no-tangle.mjs`** — fails on slug/name collisions, gateway-in-name, or served-but-unpayable backends.
- **`qa.mjs` / `reverify.mjs` / `missed.mjs` / `dump.mjs`** — QA + re-verification readers over candidates vs. shipped data.
- **`scripts/registry/_deprecated/`** — retired, disabled scripts (hard-exit guard) kept for reference: `add-stable-family.mjs` (defined dead endpoints + minted colliding ids), `enrich-accepts.mjs` (by-subcat writer → drift). Don't run them; add services via the curation procedure above.
- `candidates/` = raw probed discovery per subcat; `curation/` = hand-editable curation decisions; `.cache/` = on-disk fetch cache (gitignored).
- **x402 "run gateway" services (monid, etc.)** — some providers (e.g. Apollo, TikHub, Apify, Akta, PDL) are fronted by an aggregator's single **`POST https://x402.monid.ai/v1/run`** endpoint: pure x402 (Base USDC, no API key — the key on `api.monid.ai/v1/discover|inspect` is discovery-only, never called at runtime), **synchronous** (result inline in the 200 under `output`, no poll), with the target selected in the request BODY: `{provider, endpoint, input:{queryParams|body|pathParams}}`. These are curated as normal POST backends (url = the run endpoint) where the **agent supplies the whole envelope verbatim** — pinned via `usage.inputExample` + `usage.guide` (now inlined into recipes by `compile.ts`), NOT a `modelParam`. `provider`+`endpoint` are copied, never invented. The dynamic 402 amount already covers the full provider cost, so set the backend `amount`/accepts from a live 402 probe of that exact `{provider,endpoint}` body. `run.ts:isEmptyResultBody` also looks one level into `output` so a paid-but-empty monid result triggers the switch guardrail.

### Out of SPEC v1 scope (present but separate)

`src/app/dashboard/*` (billing, connections, limits, profile), Stripe-Link card linking (`src/components/account/`), spend caps (`src/lib/spend-buckets.ts`), and the account menu are a **mock** of the broader product (the grand vision: an OAuth-authed remote MCP where an agent's calls are paid via the user's connected card). They are not part of the v1 registry/catalog spec — don't treat them as registry work.

### Bundle Studio (`src/app/bundles`, `src/components/studio`, `src/lib/studio`) — see `BUNDLE_STUDIO_SPEC.md`

A visual, node-based workflow builder that composes registry services into reusable, runnable **bundles**. Ported from the Flow project (`@xyflow/react` canvas + Jotai store), re-pointed at MasterKey's registry + Messages-API brain. Key conventions:

- **The GRAPH is the source of truth.** A `BundleGraph` (§1.1, `src/lib/studio/types.ts`) is compiled by `compile.ts` (`compileRecipe`) into a single `CompiledRecipe`, from which BOTH the brain's run instructions (`renderRecipeForBrain`) and the SKILL.md/JSON takeaway (`export.ts`) are derived — never drift them (§1.4). The compiler also accepts legacy linear `steps[]` (curated `data/bundles/*.json`) unchanged.
- **Canvas ⇆ stored model** cross the boundary via `serialize.ts` (`canvasToGraph`/`graphToCanvas`): the canvas works in Flow's `WorkflowNode` (`data.type` for xyflow's renderer map); the stored/compiled model is §1.1 `BundleNode` (`kind`).
- **Service nodes are registry-backed, never live-probed.** A node stores a `serviceId` (+ an embedded `BundleService` snapshot for display/export); the real endpoint is re-resolved FRESH at compile/run time. The brain NEVER invents endpoints — `assist.ts`/`run.ts` copy them from the registry.
- **Two brains, same Messages-API key as `src/lib/agent/brain.ts`:** `src/lib/studio/assist.ts` (`runAssist`) is the canvas AI build-assist (add/update/connect/remove/draft nodes + `get_run_result` debug loop); `generate.ts` (`generateBundleRecipe`, reuses `runAssist`) powers the quick-bar "Generate bundle". Both follow **adaptive service selection** (respect a correct pinned pick, correct a wrong-capability pick, supplement gaps) and the **"do text work yourself"** rule (writing/summarizing → `instruction` nodes, never a chat-completion service). Guardrails mirror `skill.ts` (MAX_ROUNDS/MAX_TOKENS/node caps).
- **Persistence:** user bundles live in Mongo (`COLLECTIONS.bundles`, `store.ts`, ownership by `ownerUserId`, per-owner unique slug); curated bundles keep loading from `data/bundles/*.json` (`ownerUserId === null`). Served through auth-gated `/api/studio/*` routes (the two registry-search routes are intentionally public catalog reads); the expensive brain routes (`/api/studio/assist`, `/api/studio/generate`) are rate-limited in `proxy.ts`.
- **Running/testing:** a bundle runs like any goal — `/api/runs` resolves a leading `/slug` (own-then-curated), compiles the recipe, and threads it through the existing durable Trigger task. The builder's in-canvas **test drawer** (`test-run-drawer.tsx`) collects `inputs[]` up-front, runs the compiled bundle, shows the live transcript via `<RunView embedded>`, and hands terminal runs back to the assist brain for review/fix.

### Styling

- Tailwind CSS v4 with PostCSS (`@tailwindcss/postcss`).
- Design tokens in `globals.css` use OKLch color space.
- shadcn/ui components in `src/components/ui/` (Radix Nova theme via `components.json`); add new ones with the shadcn CLI.
- All `cn()` calls go through `src/lib/utils.ts`.

## Trigger.dev v4 — as used in this project

📖 **Full API reference: `TRIGGER.md`** (the auto-vendored v4 docs, moved out of this file — batch
triggering, debouncing, tags, metadata, queues, machine presets, logging, hidden tasks, the other build
extensions, Realtime/React hooks). For anything current, prefer the **context7 MCP** over that vendored
copy — it goes stale, context7 doesn't. Below is only what this codebase actually relies on.

**Breaking rules (v3 patterns are all over training data and will break the app):**
- `import { task, wait, schedules, tasks, runs, timeout } from "@trigger.dev/sdk"` — never `/v3`.
- **NEVER `client.defineJob`** (v2/v3). Tasks are `task({ id, run })` / `schedules.task({ id, cron, run })`.
- `triggerAndWait()` returns a **`Result`**, not the task's output — check `result.ok` before
  `result.output`. And **never wrap `triggerAndWait` / `batchTriggerAndWait` / `wait.*` in
  `Promise.all`** — unsupported inside tasks.
- Waits > 5s are checkpointed and cost **$0** while paused — that's what makes the 24h approval pause free.

**The entire surface this repo uses** (3 tasks in `src/trigger/`, wired through the §6 runtime seam in
`src/lib/runtime/trigger.ts`): `task` · `schedules.task` · `wait.createToken` / `wait.forToken` /
`wait.completeToken` / `wait.for` · `tasks.trigger` · `runs.retrieve` / `runs.cancel` ·
`idempotencyKey` · `maxDuration` / `timeout.None` · `additionalFiles`. Anything else → `TRIGGER.md`
or context7.
- `masterkey-run` — the durable brain loop. `maxDuration: timeout.None` so a long approval pause is
  never killed by the duration cap. The send-approval gate is a **waitpoint**: `wait.createToken` →
  `wait.forToken`, completed by the ownership-checked `/api/runs/[id]/approve`.
- `reaper` + `reconciler` — `schedules.task` crons.

**Deploy / env gotchas (each of these has bitten us):**
- ⚠️ **`trigger.dev deploy` builds from the LOCAL WORKING TREE, not git.** Uncommitted or half-finished
  work ships to prod. Deploy from a clean tree. (Vercel is safe — it builds from the pushed commit.)
- ⚠️ **Pin the CLI to the installed SDK: `npx trigger.dev@4.4.6`.** `@latest` aborts with a version
  mismatch (`@trigger.dev/{sdk,build,react-hooks}` are all `^4.4.6`).
- ⚠️ **`additionalFiles` bundles `data/registry/**` + `data/bundles/**`** (`trigger.config.ts`). The task
  reads the server-only registry in-process (`seed-prompt.ts` / `approval-rules.ts` → `getIndex` →
  `readFileSync`); the deploy container's cwd is `/app`, so without this it throws
  `ENOENT /app/data/registry/index.json` and seeded runs die before turn 0. **A registry or curated-bundle
  change needs a Trigger deploy to reach the runner**, not just a Vercel deploy.
- The **project ref lives in `trigger.config.ts`** (`project: "proj_…"`), NOT an env var —
  `TRIGGER_PROJECT_REF` is unused by the standard flow.
- The deployed app's `TRIGGER_SECRET_KEY` must be the **prod** key (`tr_prod_…`) or triggers land in the
  dev env and never run. Non-interactive CLI deploys use `TRIGGER_ACCESS_TOKEN` (`tr_pat_…`).
- **Local runs need `npx trigger.dev@4.4.6 dev` running** alongside `npm run dev`, or they sit `queued`
  forever. `getRuntime()` returns the Trigger impl when `TRIGGER_SECRET_KEY` is set, else a Mongo-polling
  fallback.
- `retries.enabledInDev: true` — dev re-attempts a crashed run like prod. Safe because the MCP
  `run_idempotency` record is the double-charge guard, not the runtime.
