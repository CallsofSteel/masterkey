// Masterkey — result-renderer resolution (W7). Resolves a renderer KEY by result.render →
// modalityOut → output type → category → fallback, driven by the runtime RunResult envelope (NOT
// the catalog index). The static-JSX dispatch lives in ResultStep.tsx (components must be referenced
// statically, not selected into a variable and rendered — react-hooks/static-components).
//
// ADD A COMPONENT (the recipe): write `XResult({ result }: ResultProps)` under results/, add its key
// to RendererKey + the modality/category mapping here, then add a `case` in ResultStep.tsx.

import type { RunResult } from "@/lib/mcp/types";

export type RendererKey = "image" | "video" | "audio" | "json";

const BY_MODALITY: Record<string, RendererKey> = {
  image: "image",
  video: "video",
  audio: "audio",
  text: "json",
  json: "json",
  url: "json",
};

function fromCategory(category: string): RendererKey | null {
  const c = category.toLowerCase();
  if (c.includes("image")) return "image";
  if (c.includes("video")) return "video";
  if (c.includes("audio") || c.includes("voice") || c.includes("speech") || c.includes("music")) return "audio";
  return null;
}

export function resolveRendererKey(result: RunResult): RendererKey {
  // 1) explicit hint
  if (result.render && BY_MODALITY[result.render.toLowerCase()]) return BY_MODALITY[result.render.toLowerCase()];
  // 2) output modality
  for (const m of result.modalityOut ?? []) {
    const k = BY_MODALITY[m.toLowerCase()];
    if (k) return k;
  }
  // 3) infer from an output's own type (some services don't set modalityOut)
  for (const o of result.outputs ?? []) {
    const k = BY_MODALITY[o.type];
    if (k) return k;
  }
  // 4) category heuristic, then 5) fallback
  return fromCategory(result.category ?? "") ?? "json";
}
