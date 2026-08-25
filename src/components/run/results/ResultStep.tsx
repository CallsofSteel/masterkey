"use client";

// Masterkey — static-JSX dispatcher for the W7 renderer registry. Resolves a key, then renders the
// matching component directly (components referenced statically → satisfies react-hooks/static-components).

import { resolveRendererKey } from "@/components/run/results/registry";
import type { ResultProps } from "@/components/run/results/types";
import { ImageResult } from "@/components/run/results/ImageResult";
import { VideoResult } from "@/components/run/results/VideoResult";
import { AudioResult } from "@/components/run/results/AudioResult";
import { JsonResult } from "@/components/run/results/JsonResult";

export function ResultStep({ result, onSave }: ResultProps) {
  // Defense in depth: every renderer assumes a well-formed RunResult (outputs[]). Never crash the whole
  // transcript on a malformed one — StepCard already filters; this is the backstop.
  if (!result || !Array.isArray(result.outputs)) return null;
  switch (resolveRendererKey(result)) {
    case "image":
      return <ImageResult result={result} onSave={onSave} />;
    case "video":
      return <VideoResult result={result} onSave={onSave} />;
    case "audio":
      return <AudioResult result={result} onSave={onSave} />;
    default:
      return <JsonResult result={result} onSave={onSave} />;
  }
}
