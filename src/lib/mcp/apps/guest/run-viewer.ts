// Masterkey × MCP Apps — the run-viewer guest (runs INSIDE the host's sandboxed iframe). §5/§6/§9.
//
// ⚠️ NOT imported by the Next app. esbuild ENTRY POINT → bundled into a single self-contained HTML
// (data/mcp-apps/run-viewer.html) by scripts/mcp-apps/build-viewer.mjs and served as the
// ui://masterkey/run-viewer@<hash> resource. Typechecked by tsc (under src); never in the Next bundle.
//
// Thin App wrapper: completes the ui/initialize handshake, then renders each tool-result via the pure,
// testable `renderInto` (render.ts). A persistent #status line keeps the iframe at a stable baseline
// height (works around claude.ai's iframe-height quirk #69) and reports what the iframe received.

import { App } from "@modelcontextprotocol/ext-apps";
import { renderInto, renderProgress, type ToolResultParams } from "@/lib/mcp/apps/guest/render";

const statusEl = (): HTMLElement => document.getElementById("status") as HTMLElement;
const rootEl = (): HTMLElement => document.getElementById("root") as HTMLElement;
// The #status line keeps the iframe at a stable baseline height before any result arrives (claude.ai
// collapses an empty iframe — #69). It's shown for the connecting/error states and HIDDEN once a
// result renders (the rendered content then carries the height).
const setStatus = (t: string) => {
  const s = statusEl();
  if (s) {
    s.textContent = t;
    s.hidden = false;
  }
};
const hideStatus = () => {
  const s = statusEl();
  if (s) s.hidden = true;
};

const app = new App({ name: "Masterkey Run Viewer", version: "1.0.0" });

const openLink = (url: string) => {
  void app.openLink({ url }).catch(() => {});
};

/** A pending async job in a tool result → its jobId (else null). */
const pendingJobId = (params: ToolResultParams): string | null => {
  const sc = params.structuredContent;
  if (sc && sc.kind === "job" && sc.status === "pending" && typeof sc.jobId === "string") return sc.jobId;
  return null;
};

// Phase 3 interactivity: when a result is a PENDING job AND the host can proxy tool calls
// (serverTools), the widget drives the wait itself — show a live progress card and poll get_result via
// callServerTool, rendering the media the moment it's ready. The agent therefore never polls. If the
// host can't proxy tool calls, we leave the static "job submitted" card (the agent's server-side
// long-poll still completes the job and the next get_result render shows the media). Never throws.
let polling = false;
async function pollJob(jobId: string): Promise<void> {
  if (polling || !app.getHostCapabilities()?.serverTools) return;
  polling = true;
  const root = rootEl();
  const startedAt = Date.now();
  const MAX_MS = 5 * 60 * 1000; // give up after ~5 min (job is likely stuck)
  renderProgress(root, { title: "✨ Generating…", label: "Starting…" });
  const ticker = window.setInterval(() => {
    const el = document.getElementById("mk-elapsed");
    if (el) el.textContent = `Working… ${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  try {
    for (let i = 0; i < 60; i++) {
      let res: Awaited<ReturnType<typeof app.callServerTool>>;
      try {
        res = await app.callServerTool({ name: "get_result", arguments: { jobId } });
      } catch {
        return; // transport/host failure → stop; leave the progress card (user can ask again in chat)
      }
      const rparams: ToolResultParams = {
        content: res.content as ToolResultParams["content"],
        structuredContent: res.structuredContent as ToolResultParams["structuredContent"],
        isError: res.isError,
      };
      if (!pendingJobId(rparams)) {
        renderInto(root, rparams, openLink); // complete or error → final render, done
        return;
      }
      if (Date.now() - startedAt > MAX_MS) {
        renderInto(root, rparams, openLink); // timed out → show the last (static) pending card
        return;
      }
      await new Promise((r) => setTimeout(r, 1500)); // small gap; each get_result long-polls ~20s server-side
    }
  } finally {
    window.clearInterval(ticker);
    polling = false;
  }
}

app.ontoolresult = (params) => {
  try {
    const p = params as ToolResultParams;
    renderInto(rootEl(), p, openLink);
    hideStatus(); // the result now carries the iframe height
    const jobId = pendingJobId(p);
    if (jobId) void pollJob(jobId);
  } catch {
    setStatus("Could not render this result.");
  }
};

void app
  .connect()
  .then(() => setStatus("Loading result…"))
  .catch(() => setStatus("Could not connect to the host."));
