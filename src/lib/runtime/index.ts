// Masterkey — runtime-adapter seam entry (server). Callers use getRuntime() + the shared types;
// they never import an engine SDK directly. Track A returns the Mongo-backed fallback; Track B will
// select the Trigger.dev impl here (e.g. when TRIGGER_SECRET_KEY is present) with zero caller changes.

import type { RunRuntime } from "@/lib/runtime/types";
import { fallbackRuntime } from "@/lib/runtime/fallback";
import { triggerRuntime } from "@/lib/runtime/trigger";

export type {
  RunRuntime,
  RunStartInput,
  ApprovalDecision,
  RunStatus,
  RunDoc,
  RunStepDoc,
  RunSubscriptionResult,
} from "@/lib/runtime/types";

export function getRuntime(): RunRuntime {
  // Trigger.dev when configured (Track B); the Mongo-backed fallback otherwise (UI-only / Track A).
  return process.env.TRIGGER_SECRET_KEY ? triggerRuntime : fallbackRuntime;
}
