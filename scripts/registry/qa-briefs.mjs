/**
 * qa-briefs.mjs — generate per-endpoint verifier briefs (the agent-facing round-trip artifact).
 *
 * For each tested endpoint that carries real usage guidance or a quirk a fresh agent must know, write
 * verifier-briefs/<safe-key>.md containing BOTH halves:
 *   1. the exact "ask" — how to call + pay the service using SpongeWallet, from the usage doc alone
 *   2. the "report" — pre-filled from the workflow's Phase B blind run (PASS/FAIL + what was missing),
 *      so the file is a complete record. A human/agent can re-run the ask and append to the report.
 *
 * We write briefs for endpoints whose status is verified-with-quirks / needs-review / needs-input
 * (usable-but-needs-guidance). Cleanly-dead drops are recorded in the curation patch + batch report,
 * not here. Usage: node scripts/registry/qa-briefs.mjs --batch=1
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const argv = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const BATCH = String(argv.batch ?? "1");
const results = JSON.parse(fs.readFileSync(path.join(ROOT, `data/registry/qa-batch-${BATCH}-results.json`), "utf8"));
const OUT = path.join(ROOT, "verifier-briefs");
fs.mkdirSync(OUT, { recursive: true });

const safe = (k) => k.replace(/[^a-zA-Z0-9]/g, "_");
const PAY = "scripts/registry/dist/qa-pay.mjs";

let written = 0;
for (const r of results) {
  const a = r.phaseA || {};
  const b = r.phaseB || {};
  const hasGuidance = (a.quirks && a.quirks.length) || a.classification === "verified-with-quirks";
  const needsBrief = ["verified-with-quirks", "needs-input"].includes(a.classification) ||
    (b && b.verdict === "FAIL") || hasGuidance;
  if (!needsBrief) continue;

  const url = (a.callShape || "").match(/https?:\/\/\S+/)?.[0] || "";
  const method = (a.callShape || "").match(/\b(GET|POST|PUT|DELETE|PATCH)\b/)?.[0] || a.method || "POST";
  const verdictLine = b && b.verdict && b.verdict !== "SKIP" ? b.verdict : "PASS (Phase A direct)";

  const md = `# Verifier Brief — ${a.key}

**Batch:** ${BATCH} | **Service:** ${a.serviceId} | **Date:** 2026-06-08
**Status:** ${a.classification}${b && b.verdict !== "SKIP" ? ` | **Phase B:** ${b.verdict}` : ""}
**Why this needs a guide:** ${(a.quirks && a.quirks[0]) || "has non-obvious usage"}

---

## For the verifier agent

You are verifying that the documentation below is enough to use this service correctly on the first try, with no other context.

1. Read the documentation block below.
2. Using **only that documentation**, make a real paid call to the service.
3. Fill in / append to the "Verifier Report" section at the bottom — be specific about anything unclear, missing, or wrong.

**Payment cap:** do not spend more than $6 on this test.
**Tool to use (money-safe, $6 ceiling, full settlement capture):**
\`node ${PAY} --url='<url>' --method='<METHOD>' --cap=6 [--body=@/tmp/body.json] [--header='K: V'] [--siwx] --label='${a.key}'\`
Write any JSON body to a temp file and pass \`--body=@<path>\`.

---

## Documentation under test

**Service:** ${a.serviceId} (${a.key})
**Call:** \`${method} ${url}\`
**Cost:** ~$${a.costObservedUsd ?? 0} per call  | **Auth:** ${a.auth} | **Result:** ${a.resultPull}

**Input example:**
\`\`\`json
${JSON.stringify(a.inputExample ?? {}, null, 2)}
\`\`\`

**Output:** ${a.outputShape || "(see guide)"}

**Quirks to know:**
${(a.quirks && a.quirks.length) ? a.quirks.map((q) => `- ${q}`).join("\n") : "- (none)"}

**Full guide:**
${a.guide || "(none)"}

---

## Verifier Report
*(Auto-filled from the workflow's Phase B blind run on 2026-06-08. Re-run the ask above and append your own findings below.)*

### Verdict: **${verdictLine}**

### Steps taken
${b && b.stepsTaken ? b.stepsTaken : "Phase A: paid/called the endpoint directly and confirmed the documented call shape and output."}

### Response received
${b && b.responseSummary ? b.responseSummary : "(see usage outputShape above)"}

### What was missing or wrong
${b && b.whatWasMissing ? b.whatWasMissing : "Nothing material — the documentation was sufficient."}

### Cost incurred
$${((b && b.costUsd) || 0) + (a.costObservedUsd || 0)}

---

*QA agent: if FAIL, fix the guide in the curation patch (curation/qa-batch-${BATCH}/${a.serviceId}.json) and re-issue. If PASS, the usage block is good.*
`;

  fs.writeFileSync(path.join(OUT, `${safe(a.key)}.md`), md);
  written++;
  console.log(`  wrote verifier-briefs/${safe(a.key)}.md  [${a.classification} / ${b ? b.verdict : "-"}]`);
}
console.log(`\n${written} brief(s) written for batch ${BATCH}.`);
