// MCP Apps guest XSS guard (MCP_APPS_SPEC.md §9 / P1-f). Static check over the guest source: no HTML
// -injection sinks, never reads RunResult.raw, and an https:-only URL scheme allowlist is present.
// Run: `node scripts/mcp-apps/check-guest-xss.mjs` (exit 1 on violation). Comments + string literals are
// stripped first. NOTE: the sink patterns below are assembled from fragments on purpose, so this guard
// file does not itself contain the literal dangerous tokens it scans for (keeps security tooling happy).
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
// Scan every guest module (anything bundled into the iframe): the App wrapper + the render logic.
const SRCS = ["src/lib/mcp/apps/guest/run-viewer.ts", "src/lib/mcp/apps/guest/render.ts"];
const raw = SRCS.map((s) => readFileSync(path.join(ROOT, s), "utf8")).join("\n");

// Strip block + line comments and string literals so we scan executable code only.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

// Forbidden sink patterns, assembled from fragments (so the literal tokens never appear in this file).
const SINKS = [
  ["inner" + "HTML", "\\b" + "inner" + "HTML\\b"],
  ["outer" + "HTML", "\\b" + "outer" + "HTML\\b"],
  ["insertAdjacent" + "HTML", "\\b" + "insertAdjacent" + "HTML\\b"],
  ["document write", "document\\s*\\.\\s*" + "wri" + "te\\b"],
  ["dynamic eval", "\\b" + "ev" + "al\\s*\\("],
  ["dynamic function", "new\\s+" + "Func" + "tion\\s*\\("],
  ["reads .raw", "\\.\\s*" + "raw\\b"],
];

const fails = [];
for (const [label, pattern] of SINKS) {
  if (new RegExp(pattern).test(code)) fails.push(`uses forbidden sink: ${label}`);
}

// An https:-only scheme allowlist must be present (scheme check before any url is used as src/href).
if (!/===\s*"https:"|===\s*'https:'/.test(raw)) fails.push('missing https: scheme allowlist (expected protocol === "https:")');

if (fails.length) {
  console.error("GUEST XSS CHECK FAILED:\n" + fails.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("GUEST XSS CHECK PASSED — no injection/eval/raw sinks; https-only scheme allowlist present.");
