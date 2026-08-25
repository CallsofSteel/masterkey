// Masterkey — async-job DETECTION + CLASSIFICATION (pure, server-only, NO wallet/db/network deps).
// Split out of jobs.ts so this money-/IO-free core is unit-testable in isolation (scripts/test/async-engine.mts)
// and shared by jobs.ts (polling) + run.ts (submit detection). See RUN_RELIABILITY_SPEC 3.2 + the 8-axis audit.
//   • detectAsyncJob   — is the submit response an async job? where do we poll? (axes 1/2/4)
//   • classifyJobBody  — is a poll body complete / failed / pending? (axis 6, incl. statusFromHttp)
//   • resolvePoll{Body,Headers} — {id}-templated poll request body/headers (axis 3)
import type { JobStatus } from "@/lib/mcp/types";
import type { AsyncSpec } from "@/data/types";

const COMPLETE = new Set(["complete", "completed", "succeeded", "success", "done", "ready", "finished"]);
const PENDING = new Set(["pending", "queued", "in_progress", "in-progress", "processing", "running", "started", "submitted"]);
const FAILED = new Set(["failed", "error", "errored", "cancelled", "canceled", "rejected", "expired"]);

// RUN_RELIABILITY_SPEC 3.2: status can live under any of these field names. The generalized scan (used
// when the registry doesn't pin a `submitStatusField`) reads the FIRST present one — `task_status` is in
// the list precisely because CogVideoX returns `{task_status:"PROCESSING"}` and was being treated as sync.
const STATUS_KEYS = ["status", "state", "task_status", "taskStatus", "job_status", "jobStatus", "phase"];
const JOB_ID_KEYS = ["jobId", "job_id", "id", "request_id", "requestId", "task_id", "taskId"];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Read a dot-path (e.g. "data.jobId", "tasks.0.id") from a body; undefined if any segment is missing.
 *  Supports numeric array indices (parity with run.ts getByPath) so a job id / status nested in an array works. */
function getPath(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) {
      const i = Number(key);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (isRecord(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Status string: the registry-pinned field if given, else the first present generic key (also one level
 *  under `data`/`result`). Lowercased. */
function readStatus(body: Record<string, unknown>, field?: string): string {
  if (field) return String(getPath(body, field) ?? "").toLowerCase();
  for (const k of STATUS_KEYS) if (body[k] != null) return String(body[k]).toLowerCase();
  for (const wrap of ["data", "result"]) {
    const w = body[wrap];
    if (isRecord(w)) for (const k of STATUS_KEYS) if (w[k] != null) return String(w[k]).toLowerCase();
  }
  return "";
}

const lowerSet = (xs?: string[]): Set<string> | undefined => (xs ? new Set(xs.map((x) => x.toLowerCase())) : undefined);

/** Does the body carry a usable media result (url or base64)? Used when there's no explicit status. */
function bodyHasMedia(v: unknown, depth = 0): boolean {
  if (depth > 5 || v == null) return false;
  if (typeof v === "string") return /^https?:\/\/\S+\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)/i.test(v);
  if (Array.isArray(v)) return v.some((x) => bodyHasMedia(x, depth + 1));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["b64_json", "image_data", "audio_data", "imageUrl", "image_url", "url", "video_url", "audio_url"]) {
      if (typeof o[k] === "string" && (o[k] as string).length > 8) return true;
    }
    return Object.values(o).some((x) => bodyHasMedia(x, depth + 1));
  }
  return false;
}

/** AXIS 3: substitute {id} into the (string) values of a registry poll body template. */
export function resolvePollBody(template: Record<string, unknown> | undefined, jobId: string | undefined): unknown {
  if (!template) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) out[k] = typeof v === "string" ? v.replace(/\{id\}/g, jobId ?? "") : v;
  return out;
}
/** AXIS 3: substitute {id} into a registry poll headers template (e.g. {"X-Job-Id":"{id}"}). */
export function resolvePollHeaders(template: Record<string, string> | undefined, jobId: string | undefined): Record<string, string> | undefined {
  if (!template) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) out[k] = v.replace(/\{id\}/g, jobId ?? "");
  return Object.keys(out).length ? out : undefined;
}

/**
 * Classify a poll response → job state (RUN_RELIABILITY_SPEC 3.2). Registry-driven: uses the backend's
 * `async.poll` status field + complete/failed vocab when present, else the generalized scan (which reads
 * `task_status` etc.) → so non-standard providers aren't mis-read.
 */
export function classifyJobBody(body: unknown, spec?: AsyncSpec, httpStatus?: number): JobStatus {
  // AXIS 6 (opt-in HTTP-status completion): derive state from the poll's HTTP code when the BODY carries no
  // recognizable status — for header-only / 202-then-200 APIs. 202 (and 5xx) = pending; 4xx = failed; other
  // 2xx = complete. Body-status vocab (below) always wins when present; this only fills the no-body-status gap.
  const fromHttp = (): JobStatus | undefined => {
    if (!spec?.poll?.statusFromHttp || typeof httpStatus !== "number") return undefined;
    if (httpStatus === 202 || httpStatus >= 500) return "pending";
    if (httpStatus >= 400) return "failed";
    if (httpStatus >= 200) return "complete";
    return undefined;
  };
  if (isRecord(body)) {
    const s = readStatus(body, spec?.poll?.statusField ?? spec?.submitStatusField);
    const complete = lowerSet(spec?.poll?.completeValues) ?? COMPLETE;
    const failed = lowerSet(spec?.poll?.failedValues) ?? FAILED;
    const pending = lowerSet(spec?.submitPendingValues) ?? PENDING;
    if (complete.has(s)) return "complete";
    if (failed.has(s)) return "failed";
    if (pending.has(s)) return "pending";
    const http = !s ? fromHttp() : undefined; // only when the body has no status of its own
    if (http) return http;
    // CURATED spec → the status field is AUTHORITATIVE; an unknown status means still-pending. Do NOT fall
    // through to the media heuristic below: providers echo the INPUT media URLs in the poll body (e.g.
    // seedance i2v returns input.urls=[...png] while status:"loading"), which would falsely read as "complete"
    // and surface no video. (The real result URL is pulled separately via poll.resultPath when complete.)
    if (spec?.poll?.completeValues || spec?.poll?.statusField || spec?.submitStatusField || spec?.isAsync) return "pending";
    // Uncurated heuristic only: some providers nest the finished media under `result`/`data`.
    if (isRecord(body.result) && bodyHasMedia(body.result)) return "complete";
  }
  // Non-record body (a plain string/binary result): an HTTP-status-driven provider returning the result
  // directly (not JSON) is complete on a 2xx.
  return fromHttp() ?? (bodyHasMedia(body) ? "complete" : "pending");
}

/**
 * Detect an async-job submit response and resolve the poll URL (RUN_RELIABILITY_SPEC 3.2). Registry-
 * driven first (`AsyncSpec`: explicit isAsync / status field / pending vocab / jobId path / pollUrlTemplate),
 * then a GENERALIZED heuristic (scans `task_status` etc. + common job-id keys) so a provider like CogVideoX
 * (`{task_status:"PROCESSING"}`) is recognized as async — NOT charged-as-sync and returned as junk JSON.
 * `http` carries the submit response's status code + headers so a 202 / Location-header async (axes 1/4) works.
 */
export function detectAsyncJob(
  body: unknown,
  backendUrl: string,
  spec?: AsyncSpec,
  http?: { status?: number; headers?: Record<string, string> },
): { providerJobId?: string; pollUrl: string } | null {
  if (spec?.isAsync === false) return null; // registry says this backend is synchronous → never a job
  const rec = isRecord(body) ? body : {}; // AXIS 1: a 202/Location async submit may have an empty/non-JSON body

  // AXIS 1/4 (HTTP-level async): a 202 status and/or a Location header signal an async job whose poll URL the
  // body may not carry. Headers are lowercased by wallet.headerMap.
  const headers = http?.headers ?? {};
  const locationHeader = asStr(headers["location"]) ?? asStr(headers["content-location"]);
  const is202 = http?.status === 202;

  const pending = lowerSet(spec?.submitPendingValues) ?? PENDING;
  const status = readStatus(rec, spec?.submitStatusField);
  const objStr = String(rec.object ?? rec.type ?? "").toLowerCase();
  // Coerce to string: some providers return a NUMERIC job id (e.g. 2Captcha taskId), which asStr alone drops.
  const asId = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
  const jobId =
    asId(getPath(rec, spec?.jobIdPath)) ??
    JOB_ID_KEYS.map((k) => asId(rec[k])).find(Boolean) ??
    undefined;

  const looksAsync =
    spec?.isAsync === true ||
    !!spec?.pollUrlTemplate ||
    is202 || // AXIS 1: HTTP 202 Accepted = async
    pending.has(status) ||
    objStr.includes("job") ||
    typeof rec.poll_url === "string" ||
    typeof rec.pollUrl === "string" ||
    !!locationHeader; // AXIS 4: a Location header points at where to poll
  if (!looksAsync) return null;
  // If it already carries the finished media (and isn't explicitly pending/202), it's a sync result.
  if (!is202 && !pending.has(status) && bodyHasMedia(rec)) return null;

  let origin = "";
  try {
    origin = new URL(backendUrl).origin;
  } catch {
    /* ignore */
  }

  const templateNeedsId = !!spec?.pollUrlTemplate?.includes("{id}");
  // A template that needs {id} but we have no job id → can't target the job from the template. Bail UNLESS the
  // provider handed us a Location header to poll instead (avoids emitting a poll URL with an empty {id}).
  if (templateNeedsId && !jobId && !locationHeader) return null;

  let pollUrl: string | undefined;
  if (spec?.pollUrlTemplate && (jobId || !templateNeedsId)) {
    // Curated template wins (when usable): substitute {origin}/{id}.
    pollUrl = spec.pollUrlTemplate.replace(/\{origin\}/g, origin).replace(/\{id\}/g, encodeURIComponent(jobId ?? ""));
    if (!pollUrl.startsWith("http")) pollUrl = origin + (pollUrl.startsWith("/") ? "" : "/") + pollUrl;
  } else {
    // Else: provider-given poll_url, then the Location header (AXIS 4), then the /api/jobs/{id} convention.
    const rawPoll = asStr(rec.poll_url) ?? asStr(rec.pollUrl) ?? locationHeader;
    if (rawPoll) pollUrl = rawPoll.startsWith("http") ? rawPoll : origin + (rawPoll.startsWith("/") ? "" : "/") + rawPoll;
    else if (jobId && origin) pollUrl = `${origin}/api/jobs/${encodeURIComponent(jobId)}`; // common convention fallback
  }

  if (!pollUrl) return null;
  return { providerJobId: jobId, pollUrl };
}

/**
 * True if a body carries an EXPLICIT "still processing" status (RUN_RELIABILITY_SPEC 3.3). Used by the
 * unfinished-sync guard so a provider that returns a pending body we couldn't turn into a pollable job
 * isn't presented as a successful result.
 */
export function bodyHasPendingStatus(body: unknown, spec?: AsyncSpec): boolean {
  if (!isRecord(body)) return false;
  const pending = lowerSet(spec?.submitPendingValues) ?? PENDING;
  return pending.has(readStatus(body, spec?.poll?.statusField ?? spec?.submitStatusField));
}
