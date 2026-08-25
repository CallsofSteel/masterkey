"use client";

// Fallback renderer (W7): text → markdown, json → pretty block, url → link. Used for text/json/url
// modalities and as the default when no specific renderer matches.

import Markdown from "react-markdown";
import { FileText } from "lucide-react";
import type { RunOutput } from "@/lib/mcp/types";
import type { ResultProps } from "@/components/run/results/types";
import { ResultFrame } from "@/components/run/results/ResultFrame";

function pretty(data?: string): string {
  if (!data) return "";
  try {
    return JSON.stringify(JSON.parse(data), null, 2);
  } catch {
    return data;
  }
}

// The actual data result lives in result.raw (the agent reads it from structuredContent). Render it here
// so the user sees the real content instead of a bare {type:"json"} marker.
function rawText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function OutputBlock({ o, raw }: { o: RunOutput; raw?: unknown }) {
  if (o.type === "text") {
    const text = o.data ?? o.url ?? rawText(raw);
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  if (o.type === "url" || (o.url && o.type !== "json")) {
    return (
      <a href={o.url} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
        {o.url}
      </a>
    );
  }
  const body = o.data ? pretty(o.data) : rawText(raw) || JSON.stringify(o, null, 2);
  return <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">{body}</pre>;
}

export function JsonResult({ result }: ResultProps) {
  const outputs = result.outputs.length ? result.outputs : [{ type: "json" as const, data: "" }];
  return (
    <ResultFrame result={result} icon={<FileText className="size-3.5" />}>
      <div className="space-y-2">
        {outputs.map((o, i) => (
          <OutputBlock key={i} o={o} raw={result.raw} />
        ))}
      </div>
    </ResultFrame>
  );
}
