"use client";

import { Video as VideoIcon } from "lucide-react";
import type { ResultProps } from "@/components/run/results/types";
import { ResultFrame } from "@/components/run/results/ResultFrame";

export function VideoResult({ result, onSave }: ResultProps) {
  const out =
    result.outputs.find((o) => o.type === "video") ??
    result.outputs.find((o) => o.mime?.startsWith("video/")) ??
    result.outputs.find((o) => o.type === "url" && o.url);
  const src = out?.url ?? null;
  return (
    <ResultFrame
      result={result}
      icon={<VideoIcon className="size-3.5" />}
      downloadUrl={src}
      downloadName={`${result.serviceId}.mp4`}
      saveOutput={out}
      onSave={onSave}
    >
      {src ? (
        <video controls src={src} className="max-h-96 w-full rounded-md border" />
      ) : (
        <p className="text-sm text-muted-foreground">No video in result.</p>
      )}
    </ResultFrame>
  );
}
