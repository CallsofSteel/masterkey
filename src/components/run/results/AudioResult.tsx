"use client";

import type { RunOutput } from "@/lib/mcp/types";
import { Music } from "lucide-react";
import type { ResultProps } from "@/components/run/results/types";
import { ResultFrame } from "@/components/run/results/ResultFrame";

function srcOf(o?: RunOutput): string | null {
  if (!o) return null;
  if (o.url) return o.url;
  if (o.data) return `data:${o.mime ?? "audio/mpeg"};base64,${o.data}`;
  return null;
}

export function AudioResult({ result, onSave }: ResultProps) {
  const out =
    result.outputs.find((o) => o.type === "audio") ??
    result.outputs.find((o) => o.mime?.startsWith("audio/"));
  const src = srcOf(out);
  return (
    <ResultFrame
      result={result}
      icon={<Music className="size-3.5" />}
      downloadUrl={src}
      downloadName={`${result.serviceId}.mp3`}
      saveOutput={out}
      onSave={onSave}
    >
      {src ? (
        <audio controls src={src} className="w-full" />
      ) : (
        <p className="text-sm text-muted-foreground">No audio in result.</p>
      )}
    </ResultFrame>
  );
}
