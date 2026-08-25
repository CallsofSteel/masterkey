# MasterKey

**A pay-per-use catalog of [x402](https://x402.org) AI & data services — usable by people and by AI agents, with zero crypto knowledge on either side.** Browse a curated catalog of AI media, LLMs, voice, search, data, comms, commerce, and infra services, then *use* any of them per call. MasterKey handles the payment, auth, and spend control; that plumbing is invisible to the user.

Deployed at **[masterkey.sh](https://masterkey.sh)**.

> _A personal project. Not affiliated with, endorsed by, or associated with Coinbase._

## Why fork this?

- **~2,000 pay-tested services, with exact usage instructions.** Every entry in the registry was discovered, probed, and paid-tested for real — so each one ships with a verified schema, price, and a `usage` guide describing exactly how to call it. (Plus thousands more resolved dynamically from providers like Apify.)
- **Connect Claude or ChatGPT over OAuth — no API key.** Point the agent at MasterKey's remote MCP, log in once, and it can discover and run any service. The agent needs **zero** knowledge of x402, SIWX signing, wallets, USDC, or spend limits — the platform does all of it.
- **Or use the services right on the web app.** A person describes a goal and a durable, multi-step agent chains services to deliver it (search → scrape → enrich → generate → host → send), pausing only to approve outward sends. Or just pick one service from the catalog and run it directly. No wallet, no crypto, no keys.
- **Build workflow bundles — and export them as Skills.** A visual node builder composes registry services into reusable, runnable bundles, exportable as a `SKILL.md` an agent can pick up.
- **One curated registry powers both faces.** The same self-describing catalog serves the human UI and the agent MCP — it's the product's moat, not the payment rails.
- **Governed by design.** Payment lives behind deterministic server code: *enforce spend limits → pay → record cost → return result*. No second AI agent ever touches a wallet.

## Quick start

> **🤖 Let an agent set it up for you.** Copy the line below and paste it to your coding agent (Claude Code, Cursor, Codex, …). It will fork, install, help you get every API key, run the app, and walk you through funding the wallet:
>
> ```text
> Read and follow https://masterkey.sh/skill to help me fork, configure, and run MasterKey locally.
> ```
>
> Prefer to do it by hand? Follow the steps below.

```bash
npm install
cp .env.example .env.local      # then fill in the values (nothing real is committed)

npm run dev                      # web app + catalog + MCP route at http://localhost:3000
```

`.env.example` lists every variable with an inline note on what it's for. At minimum you need MongoDB, a Sponge wallet key (payments), CDP keys (login), the OAuth/session secrets, and an Anthropic key (the agent brain).

To exercise the **human-facing durable agent** end-to-end locally, also run the Trigger.dev worker alongside the dev server (it executes the run on your machine and reaches `localhost:3000/mcp`):

```bash
npx trigger.dev@4.4.6 dev        # pin the CLI to the installed SDK version
```

Without it, the runtime falls back to a Mongo-polling shim. The **agent-facing MCP** (`/mcp`) works with just `npm run dev` — add the server URL as a custom connector in Claude or ChatGPT and log in over OAuth.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (catalog UI + `/mcp`) |
| `npm run build` | Production build (`prebuild` rebuilds the in-chat MCP App guest bundle) |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run registry:build` | Discover / probe / report the registry pipeline |
| `npm run registry:verify-drift` | Guardrail: fail if shipped registry disagrees with curation |

No test framework is configured; targeted checks live in `scripts/test/` (e.g. `npx tsx scripts/test/async-engine.mts`) and `scripts/registry/verify-*.mjs`.

## Architecture

```
Agent ──OAuth──▶ /mcp (run_service) ─┐
                                     ├─▶ spend enforcement ─▶ Sponge master wallet (x402 pay)
Human ─▶ web app ─▶ durable run ─────┘        │
         (Trigger.dev + brain)                └─▶ record cost per user ─▶ result
```

- **Registry** (`data/registry/`, server-only) — the product's moat. Curated `Service[]` where each `backend`/`operation` carries its own verified schema, price, payment requirements, and a `usage` guide. Loaded by `src/lib/registry.ts`, served read-only through rate-limited routes (`GET /api/catalog`, `GET /api/subcat/[slug]`). Apify's actors resolve **dynamically** (not stored) via `src/lib/apify.ts`. **How the registry is built, curated, and structured → [`REGISTRY_GUIDE.md`](./REGISTRY_GUIDE.md).**
- **Agent-facing MCP** (`src/app/[transport]/route.ts`, `src/lib/mcp/*`) — MasterKey is its own OAuth 2.1 Authorization + Resource Server; discovery tools + `run_service`/`get_result`. Payment, idempotency (at-most-once), settlement confirmation, and async-job polling all live here — the connected agent sees none of it.
- **Human-facing web app** (`src/app/*`, `src/lib/agent/*`, `src/trigger/*`) — catalog UI (`catalog.tsx`) + a durable agent run: an Anthropic Messages-API tool-use loop (the "brain") on a Trigger.dev task, with code-enforced send-approval gates and a reconnectable live transcript.
- **Bundle Studio** (`src/app/bundles/*`, `src/components/studio/*`, `src/lib/studio/*`) — a visual, node-based builder that composes registry services into runnable **bundles**. The graph is the source of truth: `compile.ts` derives one recipe that BOTH the run brain and the `SKILL.md`/JSON export render from. Includes AI build-assist, a quick-bar "Generate → runnable bundle" flow, and an in-canvas test drawer.
- **Payment & spend** (`src/lib/wallet.ts`, `src/lib/spend/*`, `src/lib/siwx.ts`) — see below.

### How payments work today (and the recommended path)

Today there is **one centralized Sponge master wallet** ([`@paysponge/sdk`](https://paysponge.com)). Every call is enforced against the user's spend limit (`src/lib/spend/enforce.ts`), paid from that single wallet via x402 — v1 **and** v2, across Base/Solana/etc. — and each call's cost is recorded per user in a ledger (`src/lib/spend/ledger.ts`). SIWX-gated providers are signed transparently in `src/lib/siwx.ts`. The connected agent or web user never touches a wallet, USDC, an API key, or a signature.

Two production paths are **recommended but not yet built** — this fork is a clean starting point for either:

- **Per-user wallets ("platform wallet").** The seam already exists: `getMasterWallet()` in `src/lib/wallet.ts` is the *only* accessor callers use, and it's built (per its own comment) "so a future move to per-user agents needs no caller change." Sponge's platform SDK already provisions and connects a wallet per agent (`SpongePlatform.createAgent` / `connectAgent`), so swapping the shared wallet for one wallet per user is a change behind that single function — no call sites move. (Longer term, CDP EIP-7702 smart accounts could let x402 draw directly from each user's own connected wallet.)
- **Card-linked, pay-as-you-go billing.** Charging a card for accrued usage (OpenAI/Anthropic-style) is the recommended way to settle. **It is not implemented** — the card-linking in the account UI (`src/lib/account.tsx`) is a mock, and there is **no Stripe / card integration**. The per-user cost ledger it would settle against already exists.

**Stack:** Next 16 (App Router; middleware is `proxy.ts`, route handlers run `nodejs`), MongoDB (users / oauth / ledger / jobs / idempotency), CDP embedded wallet (login identity only), Sponge (master wallet), Anthropic SDK (the brain), Trigger.dev v4 (durable runtime), Vercel Blob (media), Upstash/Vercel KV (rate limiting), Tailwind v4 + shadcn/ui.

### Repo map

```
src/app/            UI (page.tsx, catalog.tsx, dashboard/, bundles/) + api/ + [transport]/ (the /mcp route)
src/lib/registry.ts catalog loader + dynamic-service hook
src/lib/mcp/        run_service/get_result, idempotency, async-job detection + polling
src/lib/agent/      the brain (Messages-API loop), seed prompt, approval rules
src/lib/wallet.ts   Sponge master wallet + x402 payment + settlement gate
src/lib/spend/      spend enforcement + cost ledger
src/lib/studio/     Bundle Studio: graph types, recipe compiler, assist/generate brains, export, store
src/trigger/        durable tasks: masterkey-run (brain), reconciler, reaper
src/components/studio/  the visual builder (canvas, nodes, config panels, chat-bar, test drawer)
data/registry/      the curated registry (index.json + by-subcat/*.json)
data/bundles/       curated bundles (user bundles live in Mongo)
scripts/registry/   build + curation + verification tooling
```

## Where to go next

- **[`REGISTRY_GUIDE.md`](./REGISTRY_GUIDE.md)** — the registry: model, build pipeline, curation, indexing rules. **Start here to understand the core.**
- **[`REGISTRY_DISCOVERY_GUIDE.md`](./REGISTRY_DISCOVERY_GUIDE.md)** — how to find new x402 endpoints worth indexing.
- **[`REGISTRY_INDEXING_PLAYBOOK.md`](./REGISTRY_INDEXING_PLAYBOOK.md)** — turning a discovered URL into a full registry entry, once, correctly.
- **[`REGISTRY_EDIT_START_HERE.md`](./REGISTRY_EDIT_START_HERE.md)** — the safe procedure to add, change, or hide registry entries without corrupting the generated data.
- **[`TRIGGER.md`](./TRIGGER.md)** — how Trigger.dev v4 is used here (the durable run runtime).
- **[`AGENTS.md`](./AGENTS.md)** · **[`CLAUDE.md`](./CLAUDE.md)** — conventions for contributors and coding agents.

## License

[MIT](./LICENSE) © Arash Nouruzi
