# Registry — START HERE to safely edit or expand it

**Hand this whole file to an agent.** It is a self-contained prompt: read the files it
points to, absorb the safety rules, then do the work the way it describes. Following it,
you can add, change, or hide MasterKey registry entries **without writing the wrong
scripts, overwriting generated data, or corrupting the database.**

---

## Your job

Help edit and expand the **MasterKey registry** — the curated catalog of x402
pay-per-call AI models & services at `data/registry/`. Every entry is self-describing
(how to call the backend, the real price, the payment requirements, the quirks). The
registry is the product's moat, so accuracy and integrity matter more than speed.

## 1. Read these first, in this order (form your context here)

1. **`CLAUDE.md`** (auto-loaded) — the pipeline + the load-bearing "never hand-edit
   generated files / never delete-mark instead" rules. This is authoritative.
2. **`REGISTRY_INDEXING_TASK.md`** — where the effort stands + the per-provider loop.
   **This is the entry point for adding/expanding.**
3. **`REGISTRY_INDEXING_PLAYBOOK.md`** — the validated how-to: the 3 tools, the
   per-endpoint agent brief, the exact entry shape, money safety, the decided policies.
4. **`MASTERKEY_HANDOFF.md` §5.5** — the expansion rules (service-vs-backend,
   accepts-at-index-time, no guessed provenance) + registry-editing conventions.
5. **`REGISTRY_DISCOVERY_GUIDE.md`** — only if you're discovering *new* endpoints (the
   funnel: CDP Bazaar + agentcash; `x402-search` is deprecated — do not use it).

Do **not** rely on `REGISTRY_GUIDE.md` (that's a *consumer* mirror/integration guide,
with stale counts) or anything under `docs/` (archived, finished efforts — including the
completed 2026-06 pay-test QA sweep) to decide how to edit. They are history, not law.

## 2. The non-negotiable safety rules (violating these corrupts the DB)

- 🛑 **`data/registry/by-subcat/*.json`, `index.json`, `meta.json` are GENERATED —
  NEVER hand-edit them.** They are a pure projection of `scripts/registry/curation/`.
  To change anything: edit `scripts/registry/curation/<subcat>.json` → run
  `node scripts/registry/curate.mjs --subcat=<slug>` → verify. A surgical by-subcat edit
  is **drift** and silently reverts on the next curate.
- ➕ **Additive only.** Prove it every write: `shasum -a 256` every `curation/*.json` +
  `by-subcat/*.json` + `index.json` + `meta.json` **before and after**; the diff must show
  ONLY the subcats you touched (+ index/meta). Every pre-existing entry stays byte-identical.
- 🛑 **Never delete an entry — HIDE it.** A service/backend/operation we indexed and
  tested that dies gets `status:"hidden"` + a `hiddenReason` and STAYS in the file (paid-for
  negative knowledge). **Never re-suggest or re-probe a hidden entry.**
- 💳 **Money:** per-call **$0.25 hard cap**; pay via `scripts/registry/dist/qa-pay.mjs`
  (quotes unpaid first, refuses before paying if over cap, `requireChallenge` so a non-402
  never pays); pay **at most once** per endpoint; a paid 400 is **not** retried. Every
  settled charge lands in `data/registry/qa-spend-log.jsonl` — trust it + the on-chain
  delta, not self-reports.
- 🔒 **Never bypass a security or network control, and never modify the money tool.** If a
  host won't resolve or can't be reached, **DEFER it** (record it in the ledger and move on)
  — do NOT pin IPs, edit `/etc/hosts`, inject DNS shims, or patch `qa-pay`. (A batch was
  quarantined for exactly this — see the `quarantined-security-bypass` rows in
  `data/registry/indexing-progress.jsonl`.)
- 🧾 **`accepts` come from a LIVE 402 at index time** — never backfilled or guessed.
  **Never guess** price, provenance, `firstParty`, or `team` (`curate` derives 1P/team by
  host). Never index half a service (capture its required companion endpoint too).
- 🔐 Never commit secrets/keys. Never log real PII in plaintext (test inputs are public/fake).

## 3. What to actually do

**To add / expand (new endpoints):** follow the loop in `REGISTRY_INDEXING_TASK.md`:
`next-provider-batch.mjs` (builds one provider's batch from the funnel) → agent fan-out
(one agent per endpoint: consult the index, find the real call, pay once ≤$0.25, capture
fresh accepts, fold same-model-different-host as a `backends[]` entry with evidence, defer
cleanly, write a proposal) → `apply-proposals.mjs --apply` → `curate.mjs` per touched
subcat → verify → prove additivity → commit.

**To change / hide ONE existing service:** edit its object in
`scripts/registry/curation/<subcat>.json` (upsert by `slug(name)`; to hide, set
`status:"hidden"` + `hiddenReason`) → `curate.mjs --subcat=<slug>` → verify → prove
additivity → commit.

**Always run the verify gates before committing:**
```
node scripts/registry/verify-drift.mjs        # by-subcat matches curation projection
node scripts/registry/verify-no-tangle.mjs    # no slug/name collisions, no unpayable served backend
node scripts/registry/verify-bundle-pins.mjs  # curated bundles still resolve
node scripts/registry/progress-summary.mjs    # refresh INDEXING_PROGRESS.md (the ledger view)
```
Sanity: the served-count delta should ≈ the number of new services. Then move applied
proposals to `discovery/proposals/done/` and commit (end the message with the Claude Code
co-author trailer).

## 4. Do NOT use these (wrong / retired scripts)

- Anything in **`scripts/registry/_deprecated/`** (hard-exit guarded) — `add-stable-family.mjs`
  (minted colliding ids + defined dead endpoints), `enrich-accepts.mjs` (wrote by-subcat →
  drift). Use **`enrich-accepts-durable.mjs`** if you need to backfill accepts to SOURCE.
- **`add-discovered.mjs`** — superseded single-script flow (dropped live endpoints, wrote
  null prices). Use the `next-provider-batch` → fan-out → `apply-proposals` pipeline instead.
- Don't invent a new script when a listed tool already does the job, and never write a script
  that edits `by-subcat/`/`index.json` directly.

## 5. Working agreements

Report honestly (unverified = say so). Don't push past a real unknown — defer it (nothing is
lost: over-cap keeps its price, needs-input names the blocker, everything lands in
`data/registry/indexing-progress.jsonl` with a reason). Don't re-pay the same endpoint. Commit
checkpoints so mistakes revert. If a task appears to require breaking a rule in §2, **stop and
ask the owner** — do not work around it.

_(A registry change reaches the human UI on a Vercel deploy; it reaches the durable agent
runner only after a Trigger deploy — see `CLAUDE.md`. Indexing itself needs neither.)_
