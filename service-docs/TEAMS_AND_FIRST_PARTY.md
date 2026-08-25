# MasterKey — Provider Trust Tiers

_Auto-generated from the live registry + `scripts/registry/teams.mjs` (2026-06-20). Three tiers by relationship/trust. The **team tag is identical in the registry across tiers** — the tier is grading shown here only. Run `node scripts/registry/gen-teams-doc.mjs` to refresh._

## Tier 1 — First-party providers (17)

_The service owner’s OWN host (`firstParty:true`). Highest trust; the run engine prefers these by default. (Prepaid-only providers are intentionally excluded.)_

| Provider | Own host(s) |
|---|---|
| AgentMail | `x402.api.agentmail.to` |
| AgentPhone | `api.agentphone.ai` |
| Alchemy | `x402.alchemy.com` |
| Allium | `agents.allium.so` |
| Browserbase | `x402.browserbase.com` |
| CoinGecko | `pro-api.coingecko.com` |
| CoinMarketCap | `pro-api.coinmarketcap.com` |
| Exa | `api.exa.ai` |
| Hyperbrowser | `api.hyperbrowser.ai` |
| Messari | `api.messari.io` |
| Nansen | `api.nansen.ai` |
| Parallel | `parallelmpp.dev` |
| Pinata | `402.pinata.cloud` |
| PostalForm | `postalform.com` |
| Tavily | `x402.tavily.com` |
| Zapper | `public.zapper.xyz` |
| Zerion | `api.zerion.io` |

## Tier 2 — Trusted teams (direct contact) (5)

_Third-party operators/gateways we have a direct relationship with._

| Team | Host(s) | Brands / services served |
|---|---|---|
| **BlockRun** | `blockrun.ai`, `sol.blockrun.ai`, `blockrun-web-vbsbhh7lea-uc.a.run.app` | Alibaba, Anthropic, BlockRun, ByteDance, DeepSeek, Exa, Google, OpenAI, Orthogonal, StablePhone, StableStudio, Z.ai, blockrun, sol.blockrun |
| **Merit** | `stableenrich.dev`, `stabledomains.dev`, `stableemail.dev`, `stabletravel.dev`, `stablebrowser.dev`, `www.stablebrowser.dev`, `stablestudio.dev`, `stableupload.dev`, `stablegiftcards.dev`, `stableproduct.dev`, `stableflare.dev`, `stablephone.dev`, `stablesocial.dev`, `stablefinance.dev`, `stableninja.dev`, `stablemerch.dev` | Apollo, BlockRun, Channel3, Channel3 (StableProduct), Exa, Firecrawl, Minerva, Orthogonal, StableDomains, StableEmail, StableEnrich, StableFinance, StableGiftCards, StableMerch, StableNinja, StablePhone, StableStudio, Stableflare, Whitepages, stablebrowser.dev, stableenrich, stableproduct, stablesocial, stabletravel, stableupload |
| **Sponge** | `2captcha.x402.paysponge.com`, `api.paysponge.com`, `tripadvisor.x402.paysponge.com`, `deepgram.x402.paysponge.com`, `e2b.x402.paysponge.com`, `screenshotone.x402.paysponge.com`, `rentcast.x402.paysponge.com`, `url-extractor.x402.paysponge.com`, `wolframalpha.x402.paysponge.com`, `pplx.x402.paysponge.com` | 2Captcha, Deepgram, E2B, PaySponge, Perplexity, Reducto, RentCast, Textbelt, Tripadvisor, Wolfram Alpha, screenshotone.x402.paysponge |
| **Orthogonal** | `x402.orth.sh` | AgentMail, Andi, Baseten, ElevenLabs, Google, Olostep, OpenAI, OpenAI (via orth.sh), Orthogonal, Parallel, Precip AI, StableStudio, Tavily, Xona, Z.ai, x402 Gateway |
| **Apify** | `api.apify.com` | ~16,000 Apify Store actors (dynamic) — scrapers/automation for Instagram, Google Maps, LinkedIn, Amazon, Zillow, YouTube, lead-gen, e-commerce, real-estate, etc. |

## Tier 3 — Recurring providers, own domain (lower trust) (7)

_Operators that recur in the registry but which we don’t have a close relationship with — they do run on their own registered domain. Team-tagged in the registry, graded here._

| Team | Host(s) | Brands / services served |
|---|---|---|
| **Heurist** | `mesh.heurist.xyz` | Heurist |
| **Orbis** | `orbisapi.com` | Orbis ⚠️ mostly charge-then-404 (most endpoints failed testing — to revisit; 6 active / 30 hidden) |
| **Xona** | `api.xona-agent.com` | Alibaba, Black Forest Labs, BlockRun, ByteDance, StableStudio, Xona |
| **Strale** | `api.strale.io` | Strale, Various, strale, x402node |
| **x402node** | `api.x402node.dev` | 2s, Open-Meteo, mailcheck.hugen, x402node |
| **CrushRewards** | `api.crushrewards.dev` | crushrewards |
| **2s** | `2s.io` | 2s, 2s.io |

## Tier 4 — Recurring proxies, no own domain (lowest trust) (4)

_Recurring proxy/gateway endpoints on shared platform hosts (vercel.app / workers.dev / railway.app …) — no registered domain of their own. Functional + indexed, but lowest trust._

| Team | Host(s) | Brands / services served |
|---|---|---|
| **x402 Gateway** | `x402-gateway-production.up.railway.app` | Alibaba, Black Forest Labs, BlockRun, Cohere, Google, Ideogram, Meta, Mistral AI, OpenAI, Orthogonal, StableStudio, x402 Gateway, x402.auteng |
| **gg402** | `gg402.vercel.app` | Various, gg402, gg402.vercel |
| **x402 Deployer** | `x402-deployer.x402-deployer.workers.dev` | Various, netintel-production-440c.up.railway, x402 Deployer, x402-deployer |
| **NetIntel** | `netintel-production-440c.up.railway.app` | 2s, Various, netintel-production-440c.up.railway |
