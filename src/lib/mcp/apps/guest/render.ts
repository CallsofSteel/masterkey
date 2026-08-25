// Masterkey × MCP Apps — pure render logic for the run viewer (§6/§9). Extracted from run-viewer.ts so
// it can be unit-tested in a headless browser without the App/postMessage handshake. Takes a root
// element + an `openLink` callback (so it has no dependency on the App SDK).
//
// Hard rules (§9): textContent ONLY (never innerHTML on provider data); https: URLs only; NEVER read
// RunResult.raw; output.type is server-derived (trusted enum), url/data/mime are provider-derived.

import { resolveRendererKey } from "@/components/run/results/registry";
import type { RunResult, RunOutput } from "@/lib/mcp/types";

export type ToolResultParams = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type OpenLink = (url: string) => void;

function httpsOnly(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function elem(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function linkButton(label: string, url: string, openLink: OpenLink): HTMLElement {
  const b = elem("button", "mk-link", label);
  b.addEventListener("click", () => openLink(url));
  return b;
}

/** Inline media with graceful fallback: if it errors (CSP / 404 / oversize-unmirrored), swap for a link. */
function mediaElement(kind: "img" | "video" | "audio", url: string, openLink: OpenLink): HTMLElement {
  const wrap = elem("div");
  const m = document.createElement(kind);
  m.className = "mk-media";
  if (kind !== "img") (m as HTMLMediaElement).controls = true;
  m.addEventListener("error", () => {
    wrap.replaceChildren(linkButton("Open / download", url, openLink));
  });
  (m as HTMLImageElement | HTMLMediaElement).src = url;
  wrap.appendChild(m);
  return wrap;
}

function textFromContent(content: ToolResultParams["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n\n")
    .trim();
}

function tableFrom(text: string): HTMLElement | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Record<string, unknown>[];
  if (rows.length !== data.length) return null;
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 24);
  if (cols.length === 0) return null;

  const table = elem("table", "mk-table");
  const thead = elem("thead");
  const htr = elem("tr");
  for (const c of cols) htr.appendChild(elem("th", undefined, c));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = elem("tbody");
  for (const r of rows.slice(0, 200)) {
    const tr = elem("tr");
    for (const c of cols) {
      const v = r[c];
      const cell = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      tr.appendChild(elem("td", undefined, cell)); // text node — never innerHTML
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function mediaUrls(rr: RunResult, type: RunOutput["type"]): string[] {
  if (!Array.isArray(rr.outputs)) return [];
  return rr.outputs.filter((o) => o.type === type).map((o) => httpsOnly(o.url)).filter((u): u is string => !!u);
}

function renderResult(rr: RunResult, content: ToolResultParams["content"], openLink: OpenLink): Node[] {
  const parts: Node[] = [];

  const head = elem("div", "mk-head");
  head.appendChild(elem("div", "mk-title", typeof rr.serviceName === "string" ? rr.serviceName : "Result"));
  if (typeof rr.providerCostUsd === "number") head.appendChild(elem("div", "mk-cost", `$${rr.providerCostUsd.toFixed(3)}`));
  parts.push(head);

  const summary = textFromContent(content);
  const key = resolveRendererKey(rr);

  if (key === "image") {
    if (summary) parts.push(elem("div", "mk-summary", summary));
    const urls = mediaUrls(rr, "image");
    if (urls.length) {
      const gallery = elem("div", urls.length > 1 ? "mk-gallery" : undefined);
      for (const u of urls) gallery.appendChild(mediaElement("img", u, openLink));
      parts.push(gallery);
    }
  } else if (key === "video") {
    if (summary) parts.push(elem("div", "mk-summary", summary));
    for (const u of mediaUrls(rr, "video")) parts.push(mediaElement("video", u, openLink));
  } else if (key === "audio") {
    if (summary) parts.push(elem("div", "mk-summary", summary));
    for (const u of mediaUrls(rr, "audio")) parts.push(mediaElement("audio", u, openLink));
  } else {
    // "json" key — text / url(file) / tabular json. NEVER touch rr.raw.
    const fileUrls = Array.isArray(rr.outputs)
      ? rr.outputs.filter((o) => o.type === "url").map((o) => httpsOnly(o.url)).filter((u): u is string => !!u)
      : [];
    if (fileUrls.length) {
      const card = elem("div", "mk-card");
      if (summary) card.appendChild(elem("div", "mk-summary", summary));
      for (const u of fileUrls) card.appendChild(linkButton("Open / download", u, openLink));
      parts.push(card);
    } else {
      const table = summary ? tableFrom(summary) : null;
      parts.push(table ?? elem("pre", "mk-pre", summary || "(no output)"));
    }
  }
  return parts;
}

/**
 * Render a live "generating…" progress card (Phase 3 interactive polling). Pure DOM. The elapsed line
 * has a stable id (`mk-elapsed`) so the caller's ticker can update just that text without re-rendering.
 */
export function renderProgress(root: HTMLElement, opts: { title?: string; label?: string } = {}): void {
  const card = elem("div", "mk-card mk-progress");
  const head = elem("div", "mk-progress-head");
  head.appendChild(elem("span", "mk-spinner"));
  head.appendChild(elem("div", "mk-title", opts.title || "Generating…"));
  card.appendChild(head);
  const status = elem("div", "mk-status", opts.label || "Working…");
  status.id = "mk-elapsed";
  card.appendChild(status);
  root.replaceChildren(card);
}

/** Render a tool-result into `root`. Pure DOM; `openLink` opens URLs via the host. */
export function renderInto(root: HTMLElement, params: ToolResultParams, openLink: OpenLink): void {
  const sc = params.structuredContent;
  let parts: Node[];
  if (params.isError || (sc && sc.error === true)) {
    parts = [elem("div", "mk-err", textFromContent(params.content) || (sc && typeof sc.message === "string" ? sc.message : "The tool reported an error."))];
  } else if (sc && sc.kind === "job") {
    const card = elem("div", "mk-card");
    card.appendChild(elem("div", "mk-title", "⏳ Job submitted"));
    card.appendChild(elem("div", "mk-summary", typeof sc.summary === "string" ? sc.summary : "Still processing — the result will appear when ready."));
    if (typeof sc.jobId === "string") card.appendChild(elem("div", "mk-status", `job: ${sc.jobId}`));
    parts = [card];
  } else if (sc && Array.isArray((sc as { outputs?: unknown }).outputs)) {
    parts = renderResult(sc as unknown as RunResult, params.content, openLink);
  } else {
    const text = textFromContent(params.content);
    parts = [text ? elem("pre", "mk-pre", text) : elem("div", "mk-status", "No result to display.")];
  }
  root.replaceChildren(...parts);
}
