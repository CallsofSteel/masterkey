// verify-async-specs.mjs — static batch-verify of every AsyncSpec in the BUILT registry against the
// engine's REAL contract (src/lib/mcp/jobs.ts). Catches specs that would poll-forever or never extract a
// result, WITHOUT spending a cent. Run after any async-curation batch (and in CI). Exits non-zero on ERROR.
//
//   node scripts/registry/verify-async-specs.mjs            # check served specs (gates on ERROR)
//   node scripts/registry/verify-async-specs.mjs --warn     # also exit non-zero on WARN (strict)
//   node scripts/registry/verify-async-specs.mjs --all      # include hidden services in the report
//
// What it CANNOT do: confirm a provider actually returns a video — that needs a live paid call. This is the
// structural gate (the cheap, repeatable half). The fields it checks mirror jobs.ts exactly:
//   • detectAsyncJob: pollUrl resolves from pollUrlTemplate({id}) | body.poll_url | `${origin}/api/jobs/{id}`.
//     A template with {id} needs a job id (jobIdPath, else generic JOB_ID_KEYS). A template WITHOUT {id} is
//     only OK when poll.method==="POST" and poll.body carries "{id}" (the 2Captcha pattern).
//   • classifyJobBody: a curated spec is AUTHORITATIVE — only poll.completeValues mark "complete". Empty/
//     missing completeValues ⇒ the job can NEVER complete ⇒ poll-forever. statusField may be "" (→ generic
//     STATUS_KEYS scan) — that's fine. completeValues are matched case-insensitively.
//   • mapOutput: resultPath is optional — missing ⇒ the depth-4 findUrl MEDIA heuristic (fine for media,
//     blind to JSON), with the raw body always returned as a fallback. Flagged WARN for DATA outputs.
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data/registry/by-subcat");
const argv = process.argv.slice(2);
const STRICT = argv.includes("--warn");
const INCLUDE_HIDDEN = argv.includes("--all");

// Subcategories whose result is renderable MEDIA — there the findUrl fallback covers a missing resultPath.
const MEDIA_SUBCATS = new Set([
  "image-generation", "video-generation", "voice-tts", "music-generation", "sound-effects-audio",
  "speech-to-text", "avatars-digital-humans", "image-editing-manipulation", "video-editing-transcoding",
  "transcription-subtitles", "background-removal",
]);

const ERRORS = [];
const WARNS = [];
let checked = 0;

/** Does a registry pollBody template carry the "{id}" substitution somewhere in its string values? */
function bodyCarriesId(body) {
  if (!body || typeof body !== "object") return false;
  return Object.values(body).some((v) => typeof v === "string" && v.includes("{id}"));
}

function checkSpec(a, ctx) {
  checked++;
  const where = `${ctx.sub}: ${ctx.svc} (${ctx.kind}:${ctx.who})`;
  const E = (m) => ERRORS.push(`ERROR  ${where} — ${m}`);
  const W = (m) => WARNS.push(`WARN   ${where} — ${m}`);

  // isAsync must be an explicit true for a curated async spec (false = "force sync", handled elsewhere).
  if (a.isAsync !== true) E(`isAsync is ${JSON.stringify(a.isAsync)} (a curated async spec must set isAsync:true)`);

  // ---- can the engine CLASSIFY "complete"? (classifyJobBody) -------------------------------------------
  const complete = a.poll?.completeValues;
  if (!Array.isArray(complete) || complete.length === 0)
    E(`poll.completeValues is empty — a curated spec is authoritative, so nothing ever classifies "complete" → polls forever`);

  // ---- can the engine RESOLVE a poll URL? (detectAsyncJob) --------------------------------------------
  const tmpl = a.pollUrlTemplate;
  const isPost = a.poll?.method === "POST";
  if (tmpl) {
    if (tmpl.includes("{id}")) {
      if (!a.jobIdPath) W(`pollUrlTemplate needs {id} but no jobIdPath — relies on the generic JOB_ID_KEYS scan (jobId/id/task_id/…); set jobIdPath to be safe`);
    } else if (isPost && bodyCarriesId(a.poll?.body)) {
      // OK: 2Captcha pattern — the job id rides in the POST body, not the URL.
    } else {
      E(`pollUrlTemplate has no {id} and no POST body carrying {id} — every poll hits the SAME url, can't target this job`);
    }
  } else {
    W(`no pollUrlTemplate — engine falls back to the submit body's poll_url, else \`\${origin}/api/jobs/{id}\`. Confirm the provider returns poll_url (BlockRun does) or that /api/jobs/{id} is its real poll path`);
  }

  // ---- can the engine EXTRACT the result? (mapOutput / AXIS 7 separate endpoint) ---------------------
  const hasResultPath = a.poll?.resultPath != null && a.poll?.resultPath !== "";
  const sep = a.poll?.resultUrlTemplate; // AXIS 7: result fetched from a SEPARATE endpoint
  if (sep) {
    // Separate result endpoint (allium class): validate it can target the job + has a sane cost.
    if (sep.includes("{id}") && !a.jobIdPath) W(`poll.resultUrlTemplate needs {id} but no jobIdPath — relies on the generic JOB_ID_KEYS scan; set jobIdPath`);
    const rc = a.poll?.resultCost;
    if (rc != null && !["free", "siwx", "per-poll"].includes(rc)) E(`poll.resultCost="${rc}" is invalid (free|siwx|per-poll)`);
  } else if (!hasResultPath && !MEDIA_SUBCATS.has(ctx.sub)) {
    // Non-media data result with neither resultPath nor a separate-endpoint fetch → comes back ONLY as raw JSON
    // (the brain still receives it via RunResult.raw; this is degraded structure, not data loss).
    W(`no poll.resultPath / poll.resultUrlTemplate on a non-media (data) result — the result returns ONLY as raw JSON (findUrl finds no media URL). Set resultPath, or resultUrlTemplate if the result is at a separate endpoint`);
  }
  if (a.poll?.statusFromHttp != null && typeof a.poll.statusFromHttp !== "boolean") E(`poll.statusFromHttp must be a boolean`);

  // ---- per-poll cost guardrail -----------------------------------------------------------------------
  if (a.poll?.cost === "per-poll") {
    const hasCap = a.poll?.costUsd != null || a.poll?.maxJobCostUsd != null || a.maxJobCostUsd != null;
    if (!hasCap && ctx.priceKnown !== true)
      W(`per-poll with no poll.costUsd/maxJobCostUsd AND the endpoint price is unknown — bounded only by the $0.50 env backstop; set a cap for pricier jobs`);
  }
}

for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith(".json")) continue;
  const sub = f.replace(/\.json$/, "");
  const services = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const s of services) {
    if (s.status === "hidden" && !INCLUDE_HIDDEN) continue;
    const priceKnown = s.pricing?.amount != null;
    for (const b of s.backends || []) {
      if (!b.async) continue;
      if ((b.status === "hidden" || b.status === "dead") && !INCLUDE_HIDDEN) continue;
      checkSpec(b.async, { sub, svc: s.id, kind: "backend", who: b.providerId, priceKnown: b.price?.amount != null || priceKnown });
    }
    for (const o of s.operations || []) {
      if (!o.async) continue;
      checkSpec(o.async, { sub, svc: s.id, kind: "operation", who: o.name, priceKnown: o.price?.amount != null || priceKnown });
    }
  }
}

const out = [];
if (ERRORS.length) out.push(`✗ ${ERRORS.length} ERROR(s):\n` + ERRORS.map((v) => "  " + v).join("\n"));
if (WARNS.length) out.push(`⚠ ${WARNS.length} WARN(ing)(s):\n` + WARNS.map((v) => "  " + v).join("\n"));
console.log(out.join("\n\n") || "");
console.log(`\nChecked ${checked} async spec(s). ${ERRORS.length} error(s), ${WARNS.length} warning(s).`);

if (ERRORS.length || (STRICT && WARNS.length)) process.exit(1);
console.log("✓ async specs are structurally sound (no poll-forever / unresolvable-poll-url / never-complete specs).");
