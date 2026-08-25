// Masterkey — result-renderer shared props (W7). Renderers are driven by the runtime RunResult
// envelope (R6 / §10), NOT the catalog index (EntrySummary has no modality).

import type { RunResult, RunOutput } from "@/lib/mcp/types";

export interface ResultProps {
  result: RunResult;
  /** Save-to-library hook (wired in W10). When omitted, the Save action is hidden. */
  onSave?: (output: RunOutput) => void;
}
