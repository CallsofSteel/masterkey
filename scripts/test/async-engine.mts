// async-engine.mts — money-safe synthetic tests for the async engine across all 8 axes.
// Pure functions only (no network, no wallet, no DB): detectAsyncJob + classifyJobBody. Run with:
//   npx tsx scripts/test/async-engine.mts
// Exits non-zero on any failed assertion. This is the regression gate for the async detection/classification
// logic; the live provider behavior (does the endpoint actually return a video) is a separate paid check.
import { detectAsyncJob, classifyJobBody } from "../../src/lib/mcp/async-detect";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; } else { fails.push(`✗ ${name}\n    got:  ${g}\n    want: ${w}`); }
}
const BACKEND = "https://api.provider.com/v1/submit";

// ============================ AXIS 1 + 4 — detection + poll-URL ============================
// 1a. Body pending status + job id → async; convention poll URL.
eq("A1: body pending → convention pollUrl",
  detectAsyncJob({ status: "queued", id: "abc" }, BACKEND, { isAsync: true }),
  { providerJobId: "abc", pollUrl: "https://api.provider.com/api/jobs/abc" });

// 1b. Curated pollUrlTemplate with {id}/{origin}.
eq("A4: pollUrlTemplate {origin}/{id}",
  detectAsyncJob({ status: "pending", request_id: "r9" }, BACKEND,
    { isAsync: true, jobIdPath: "request_id", pollUrlTemplate: "{origin}/jobs/{id}" }),
  { providerJobId: "r9", pollUrl: "https://api.provider.com/jobs/r9" });

// 1c. Template needs {id} but no id present and no Location → bail (don't poll an empty {id} forever).
eq("A4: template needs id, none present → null",
  detectAsyncJob({ error: "bad" }, BACKEND, { isAsync: true, pollUrlTemplate: "{origin}/jobs/{id}" }),
  null);

// 1d. AXIS 1: HTTP 202 + empty body + Location header → async, poll the Location.
eq("A1: 202 + Location header → poll there",
  detectAsyncJob("", BACKEND, { isAsync: true }, { status: 202, headers: { location: "https://api.provider.com/status/42" } }),
  { providerJobId: undefined, pollUrl: "https://api.provider.com/status/42" });

// 1e. AXIS 4: relative Location header → prefixed with origin.
eq("A4: relative Location → origin-prefixed",
  detectAsyncJob({}, BACKEND, { isAsync: true }, { status: 202, headers: { location: "/poll/7" } }),
  { providerJobId: undefined, pollUrl: "https://api.provider.com/poll/7" });

// 1f. Template needs id, no id, BUT Location present → use Location (don't bail).
eq("A4: template-needs-id + no id + Location → Location wins",
  detectAsyncJob({}, BACKEND, { isAsync: true, pollUrlTemplate: "{origin}/jobs/{id}" }, { status: 202, headers: { location: "/p/9" } }),
  { providerJobId: undefined, pollUrl: "https://api.provider.com/p/9" });

// 1g. provider-supplied body.poll_url (BlockRun pattern) — relative → origin-prefixed.
eq("A4: body.poll_url (relative)",
  detectAsyncJob({ status: "queued", id: "z", poll_url: "/v1/jobs/z" }, BACKEND, { isAsync: true }),
  { providerJobId: "z", pollUrl: "https://api.provider.com/v1/jobs/z" });

// 1h. pollUrlTemplate WITHOUT {id} (2Captcha pattern — id rides in the POST body) → template used as-is.
eq("A3/A4: template without {id} (id in POST body)",
  detectAsyncJob({ errorId: 0, taskId: 12345 }, "https://2captcha.x402.paysponge.com/createTask",
    { isAsync: true, jobIdPath: "taskId", pollUrlTemplate: "{origin}/getTaskResult",
      poll: { cost: "per-poll", method: "POST", body: { taskId: "{id}" }, completeValues: ["ready"] } }),
  { providerJobId: "12345", pollUrl: "https://2captcha.x402.paysponge.com/getTaskResult" });

// 1i. Sync result (media present, not pending, no async signal) → null (treat as sync).
eq("A1: sync media body → null",
  detectAsyncJob({ url: "https://cdn/x.png" }, BACKEND, undefined),
  null);

// 1j. isAsync:false → never a job even with a pending-looking body.
eq("A1: isAsync:false forces sync",
  detectAsyncJob({ status: "processing" }, BACKEND, { isAsync: false }),
  null);

// ============================ AXIS 2 — job-id location ============================
// 2a. Array-index jobIdPath (getPath parity with run.ts).
eq("A2: array-index jobIdPath data.0.id",
  detectAsyncJob({ data: [{ id: "arr1" }] }, BACKEND, { isAsync: true, jobIdPath: "data.0.id", pollUrlTemplate: "{origin}/j/{id}" }),
  { providerJobId: "arr1", pollUrl: "https://api.provider.com/j/arr1" });

// 2b. Numeric id coerced to string.
eq("A2: numeric id coerced",
  detectAsyncJob({ status: "queued", taskId: 777 }, BACKEND, { isAsync: true, jobIdPath: "taskId", pollUrlTemplate: "{origin}/j/{id}" }),
  { providerJobId: "777", pollUrl: "https://api.provider.com/j/777" });

// ============================ AXIS 6 — completion / failure classification ============================
const curated = { isAsync: true, poll: { cost: "free" as const, statusField: "state", completeValues: ["ACTIVE"], failedValues: ["FAILED"] } };
eq("A6: completeValues → complete", classifyJobBody({ state: "ACTIVE" }, curated), "complete");
eq("A6: failedValues → failed", classifyJobBody({ state: "FAILED" }, curated), "failed");
eq("A6: unknown status on curated spec → pending (NOT media-heuristic)",
  classifyJobBody({ state: "loading", input: { urls: ["https://x/in.png"] } }, curated), "pending");
eq("A6: generic pending vocab", classifyJobBody({ status: "processing" }, { isAsync: true }), "pending");

// AXIS 6: statusFromHttp — derive state from HTTP code when body has no status.
const httpSpec = { isAsync: true, poll: { cost: "free" as const, statusFromHttp: true } };
eq("A6: statusFromHttp 200 → complete", classifyJobBody({ data: 1 }, httpSpec, 200), "complete");
eq("A6: statusFromHttp 202 → pending", classifyJobBody({}, httpSpec, 202), "pending");
eq("A6: statusFromHttp 500 → pending (retry)", classifyJobBody({}, httpSpec, 500), "pending");
eq("A6: statusFromHttp 404 → failed", classifyJobBody({}, httpSpec, 404), "failed");
eq("A6: body status BEATS http (processing + 200 → pending)",
  classifyJobBody({ status: "processing" }, { isAsync: true, poll: { cost: "free", statusFromHttp: true, completeValues: ["done"] } }, 200), "pending");

// Uncurated heuristic (no spec): media-present → complete; nothing → pending.
eq("A6: uncurated media present → complete", classifyJobBody({ url: "https://cdn/x.mp4" }, undefined), "complete");
eq("A6: uncurated empty → pending", classifyJobBody({ foo: 1 }, undefined), "pending");

// ============================ report ============================
console.log(fails.length ? fails.join("\n") + "\n" : "");
console.log(`async-engine tests: ${pass} passed, ${fails.length} failed.`);
process.exit(fails.length ? 1 : 0);
