/**
 * qa-next.mjs — prep the next batch in one call: write the full specs to disk (for the workflow agents
 * to read via specPath) AND print the COMPACT light endpoints array (one line) to stdout for the driver
 * to inline into the Workflow `args.endpoints`. Keeps the driver's context small.
 *
 * Usage: node scripts/registry/qa-next.mjs [--n=25]
 *   writes data/registry/qa-batch-current.json (full specs)
 *   prints (stdout, single line) the light array: [{key,serviceId,name,url,method,outward}]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const N = (process.argv.find((a) => a.startsWith("--n=")) || "--n=25").split("=")[1];

const full = execFileSync("node", ["scripts/registry/next-batch.mjs", `--n=${N}`], { cwd: ROOT, encoding: "utf8" });
fs.writeFileSync(path.join(ROOT, "data/registry/qa-batch-current.json"), full);

const parsed = JSON.parse(full);
const light = (parsed.endpoints || []).map((e) => ({
  key: e.key, serviceId: e.serviceId, name: e.name, url: e.url, method: e.method,
  priceDisplay: e.priceDisplay, subcategory: e.subcategory, outward: !!e.outward,
}));
process.stdout.write(JSON.stringify(light));
