# MasterKey — Get Started (agent skill)

You are a coding agent helping a developer **fork, configure, and run [MasterKey](https://masterkey.sh) locally** (and optionally deploy it). MasterKey is a pay-per-use catalog of ~2,000 pay-tested [x402](https://x402.org) AI & data services, usable by people (web app) and by agents (a remote MCP over OAuth). Follow the steps below in order. Do the mechanical work yourself where you can; **pause to ask the developer for anything only they can provide** (account signups, secret values, spending decisions).

## Ground rules (read first)

- **Never commit secrets.** Real values go **only** in `.env.local` (gitignored). Never write them into any tracked file, and never echo a full secret back into a persisted chat log.
- **Confirm before spending real money.** Only Step 6 (funding the wallet) costs anything. Everything else — browsing, running *free* services, the whole build — is free. Do not fund a wallet without the developer's explicit OK.
- **Verify each step before moving on** (run the check commands shown). If something fails, stop and diagnose rather than pushing ahead.
- **Ask, don't guess.** If a provider's dashboard label differs from what's written here, use web search / the provider's docs to find the current path rather than inventing one.

## Step 0 — Prerequisites

Check the developer has these; help install anything missing:

```bash
node -v      # need Node 20 or newer
npm -v
git --version
```

They also need a **GitHub account** and will create free accounts on a few services below.

## Step 1 — Fork & clone

1. Have the developer **fork** the MasterKey repository on GitHub (the canonical repo is linked from https://masterkey.sh). Ask them for the fork's URL if you don't have it.
2. Clone and enter it:

```bash
git clone <their-fork-url> masterkey
cd masterkey
```

If they already have the repo cloned, just `cd` into it and skip ahead.

## Step 2 — Install dependencies

```bash
npm install
```

## Step 3 — Create the environment file

```bash
cp .env.example .env.local
```

Now fill in `.env.local`. Below is **where to get every value**, grouped by how essential it is. Work through the **Required** group with the developer, then the **Durable runs** group, then skip the **Optional** group unless they ask.

### Required (the app won't work without these)

- **MongoDB** — `MONGODB_URI` (`MONGODB_DB` can stay `masterkey`).
  Create a free cluster at **MongoDB Atlas** (mongodb.com/atlas). In the cluster: *Connect → Drivers* → copy the `mongodb+srv://…` connection string. Replace `<password>` with the DB user's password.

- **CDP (login / identity)** — `NEXT_PUBLIC_CDP_PROJECT_ID`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`.
  MasterKey uses Coinbase Developer Platform embedded wallets for **login only** (email → OTP). Go to the **CDP portal** (portal.cdp.coinbase.com): create/select a project, copy its **Project ID** → `NEXT_PUBLIC_CDP_PROJECT_ID`; then create a **server API key** → `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. Add `http://localhost:3000` to the project's allowed origins/domains.

- **Sponge (the master wallet — pays every provider)** — `SPONGE_API_KEY` **or** `SPONGE_MASTER_KEY`.
  Sign up at **paysponge.com** and open the Dashboard. Two options:
  - Simplest: create an **agent**, copy its agent key (`sponge_live_…`) → `SPONGE_API_KEY`.
  - Or: Dashboard → *Settings → Master API Keys* → create a master key (`sponge_master_…`) → `SPONGE_MASTER_KEY`. MasterKey will auto-provision/reuse an agent wallet from it.
  You'll **fund** this wallet in Step 6.

- **Anthropic (the agent "brain")** — `ANTHROPIC_API_KEY`.
  Create a key at **console.anthropic.com** → *API Keys*. Needed for the durable web-app agent, Bundle Studio assist, and bundle generation. (The var `CLAUDE_ANTHROPIC_API_KEY` is accepted as an alias if set.)

- **Auth secrets** — `OAUTH_JWT_SIGNING_KEY`, `SESSION_SECRET`, `OAUTH_ISSUER`.
  Generate two random secrets:
  ```bash
  echo "OAUTH_JWT_SIGNING_KEY=$(openssl rand -hex 32)"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  ```
  Paste those into `.env.local`. Set `OAUTH_ISSUER=http://localhost:3000` for local dev.

### For durable runs (recommended — the human-facing multi-step agent + send-approvals)

- **Trigger.dev** — `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`.
  Create a project at **cloud.trigger.dev**: copy the project ref (`proj_…`) → `TRIGGER_PROJECT_REF`; then *API Keys* → copy the **dev** secret key (`tr_dev_…`) → `TRIGGER_SECRET_KEY`.
  Without these, MasterKey falls back to a Mongo-polling shim: single-shot runs work, but there's **no durable pause/approval waitpoint**. For the full experience, set them and run the worker (Step 4).

### Optional (safe to skip locally — sensible defaults or graceful no-ops)

- **Vercel KV / Upstash** (`masterkey_KV_REST_API_URL`, `masterkey_KV_REST_API_TOKEN`) — API rate limiting. If unset, `proxy.ts` **no-ops** (no limiting). Fine for local dev.
- **Vercel Blob** (`BLOB_READ_WRITE_TOKEN`) — only needed for **media-generation** flows (image/video that upload results). Get it from Vercel → *Storage → Blob*.
- **RPC URLs, model overrides, tuning knobs** (`BASE_RPC_URL`, `MASTERKEY_AGENT_MODEL`, `MASTERKEY_MAX_TOKENS`, …) — leave the defaults.

## Step 4 — Run it

```bash
npm run dev          # web app + catalog + agent MCP at http://localhost:3000
```

For the **durable human-facing agent**, open a second terminal and run the worker (pin the CLI to the installed SDK):

```bash
npx trigger.dev@4.4.6 dev
```

Leave both running.

## Step 5 — Verify

1. Open **http://localhost:3000** — the catalog should render.
2. **Sign in** (email → OTP via CDP). Confirm you land back signed-in.
3. Browse a category and open a service — you should see its usage/schema/price.
4. **Test the agent MCP:** in Claude or ChatGPT, add a custom MCP connector pointing at `http://localhost:3000/mcp` and complete the OAuth login. The agent should be able to list categories and search services.
5. Running a *paid* service (or a full goal-run) requires a funded wallet → Step 6.

## Step 6 — Fund the master wallet (real money — get the developer's OK first)

MasterKey pays providers from the **one** Sponge wallet you configured, so it needs a small USDC balance **on Base**.

```bash
npx spongewallet balance --chain base      # shows the wallet's Base address + balance
```

Top it up either way:
- **Send USDC (Base network)** to that address from any exchange or wallet, **or**
- **Fiat on-ramp:** `npx spongewallet onramp` and follow the link.

Start small — **$5–$10** is plenty to try things (most calls cost cents). The per-call ceiling defaults to `$1.00` (`MASTERKEY_DEFAULT_PRICE_CEILING_USD`). Now retry a paid service or a goal-run in the web app.

## Step 7 — Deploy (optional)

- **Web + MCP:** deploy to **Vercel** (it builds from the pushed commit). Set all the same env vars in the Vercel project, plus `OAUTH_ISSUER=https://<your-domain>` and the production Trigger key (`tr_prod_…`).
- **Durable worker:** `npx trigger.dev@4.4.6 deploy` (non-interactive deploys use a `tr_pat_…` access token). ⚠️ Trigger builds from your **local working tree**, so deploy from a clean checkout. A registry or curated-bundle change needs a Trigger **redeploy** to reach the runner, not just a Vercel deploy.

## Troubleshooting (quick hits)

- **Runs stay "queued" forever** → the `npx trigger.dev@4.4.6 dev` worker isn't running (or `TRIGGER_SECRET_KEY` is missing).
- **CDP login fails / "invalid origin"** → add `http://localhost:3000` to the CDP project's allowed domains.
- **"Sponge API key invalid" only in prod** → the SDK's credential cache needs a writable path; `wallet.ts` already redirects it to the temp dir, so ensure you deployed current code.
- **429s locally** → you set the KV vars; unset them to disable rate limiting for dev.
- **Payments rejected as "over ceiling"** → raise `MASTERKEY_DEFAULT_PRICE_CEILING_USD`, or the wallet is out of funds (Step 6).

## Go deeper

Once it's running, these tracked docs cover real work:
- `REGISTRY_GUIDE.md` — the registry model, build pipeline, and curation.
- `REGISTRY_DISCOVERY_GUIDE.md` + `REGISTRY_INDEXING_PLAYBOOK.md` — finding and indexing new x402 endpoints.
- `REGISTRY_EDIT_START_HERE.md` — safely adding/changing/hiding entries.
- `TRIGGER.md` — how Trigger.dev v4 is used here.
- `AGENTS.md` + `CLAUDE.md` — conventions for contributors and coding agents.

When you finish, give the developer a short recap: what's configured, what's still optional, and whether the wallet is funded.
