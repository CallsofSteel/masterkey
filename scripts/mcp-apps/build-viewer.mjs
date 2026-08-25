// Masterkey × MCP Apps — guest bundle builder (MCP_APPS_SPEC.md §5.2).
//
// Bundles the guest entry (src/lib/mcp/apps/guest/run-viewer.ts) with esbuild into ONE self-contained
// HTML file (inline JS, no external script/style fetches) and writes it to data/mcp-apps/run-viewer.html.
// The MCP server serves that file as the `ui://masterkey/run-viewer@<hash>` resource; the <hash> is
// derived AT RUNTIME from the served bytes (src/lib/mcp/apps/resource.ts), so the resource URI and the
// tool's `_meta.ui.resourceUri` can never drift from the actual content.
//
// Runs in `prebuild` (so Vercel/`npm run build` regenerates it) and via `npm run build:mcp-app`.
// Keep the bundle small — hosts preload `ui://` resources.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(ROOT, "src/lib/mcp/apps/guest/run-viewer.ts");
const OUT_DIR = path.join(ROOT, "data/mcp-apps");
const OUT_HTML = path.join(OUT_DIR, "run-viewer.html");

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  legalComments: "none",
  // Resolve the "@/..." path alias (tsconfig paths) so the guest can REUSE resolveRendererKey from the
  // shared renderer registry (type-only imports inside it are erased by esbuild).
  alias: { "@": path.join(ROOT, "src") },
});

const js = result.outputFiles[0].text;

// Self-contained HTML: the only external load is the <img> (governed by the resource CSP, not a
// script/style fetch). No CDN, no external JS/CSS — so resourceDomains only needs media origins.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Masterkey Run Viewer</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 14px; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#root { display: flex; flex-direction: column; gap: 12px; }
.mk-status { color: #6b7280; font-size: 13px; }
.mk-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.mk-title { font-weight: 600; }
.mk-cost { color: #6b7280; font-size: 12px; white-space: nowrap; }
.mk-summary { color: #374151; }
@media (prefers-color-scheme: dark) { .mk-summary { color: #d1d5db; } .mk-status, .mk-cost { color: #9ca3af; } }
.mk-media { display: block; max-width: 100%; height: auto; border-radius: 10px; }
.mk-gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.mk-pre { background: rgba(127,127,127,.12); padding: 12px; border-radius: 8px; overflow: auto; max-height: 320px; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; word-break: break-word; margin: 0; }
.mk-link { appearance: none; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; font: inherit; padding: 7px 12px; border-radius: 8px; cursor: pointer; }
.mk-link:hover { background: rgba(127,127,127,.12); }
.mk-card { border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.mk-progress-head { display: flex; align-items: center; gap: 10px; }
.mk-spinner { width: 16px; height: 16px; flex: none; border: 2px solid rgba(127,127,127,.3); border-top-color: currentColor; border-radius: 50%; display: inline-block; animation: mk-spin .8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .mk-spinner { animation-duration: 2.4s; } }
@keyframes mk-spin { to { transform: rotate(360deg); } }
.mk-err { color: #b91c1c; }
table.mk-table { border-collapse: collapse; width: 100%; font-size: 13px; }
table.mk-table th, table.mk-table td { border: 1px solid rgba(127,127,127,.3); padding: 6px 9px; text-align: left; vertical-align: top; }
table.mk-table th { background: rgba(127,127,127,.1); font-weight: 600; }
</style>
</head>
<body>
<div id="status" class="mk-status">starting…</div>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_HTML, html, "utf8");

console.log(`[build-viewer] wrote ${path.relative(ROOT, OUT_HTML)} — ${html.length} bytes, hash ${hash}`);
