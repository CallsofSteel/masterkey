"use client";

import type { RunOutput } from "@/lib/mcp/types";
import { Image as ImageIcon } from "lucide-react";
import type { ResultProps } from "@/components/run/results/types";
import { ResultFrame } from "@/components/run/results/ResultFrame";

function srcOf(o?: RunOutput): string | null {
  if (!o) return null;
  if (o.url) return o.url;
  if (o.data) return `data:${o.mime ?? "image/png"};base64,${o.data}`;
  return null;
}

export function ImageResult({ result, onSave }: ResultProps) {
  const out =
    result.outputs.find((o) => o.type === "image") ??
    result.outputs.find((o) => o.mime?.startsWith("image/"));
  const src = srcOf(out);
  return (
    <ResultFrame
      result={result}
      icon={<ImageIcon className="size-3.5" />}
      downloadUrl={src}
      downloadName={`${result.serviceId}.png`}
      saveOutput={out}
      onSave={onSave}
    >
      {src ? (
        <a href={src} target="_blank" rel="noreferrer" className="block" title="Open full size">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={result.serviceName} className="max-h-96 w-auto rounded-md border object-contain" />
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">No image in result.</p>
      )}
    </ResultFrame>
  );
}
