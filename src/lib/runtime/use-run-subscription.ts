"use client";

// Masterkey — client run subscription (Track A / fallback impl of the §6 seam). Polls
// GET /api/runs/[id] (Mongo = source of truth) and returns {steps,status}; reconnects on window
// focus and stops once the run is terminal. RunView uses ONLY this hook (never useRealtimeRun
// directly — W-S M9), so swapping in the Trigger.dev Realtime impl in Track B is mechanical.
// `getToken` is accepted for signature parity (the Realtime impl needs it) but unused here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDoc, RunStatus, RunSubscriptionResult, SessionSegment } from "@/lib/runtime/types";

const TERMINAL: RunStatus[] = ["complete", "failed", "capped", "canceled"];
const POLL_MS = 1500;

export function useRunSubscription(
  runId: string,
  getToken?: () => Promise<string>,
): RunSubscriptionResult {
  void getToken; // part of the seam signature; the Realtime/Trigger impl (Track B) needs it, the polling fallback doesn't.
  const [run, setRun] = useState<RunDoc | null>(null);
  const [segments, setSegments] = useState<SessionSegment[]>([]);
  const [status, setStatus] = useState<RunStatus>("queued");
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const refetch = useCallback(() => setReload((n) => n + 1), []);
  const statusRef = useRef<RunStatus>("queued");
  // Mirror status into a ref (in an effect, not during render) so the polling closure can read the
  // latest status without re-subscribing the effect on every status change.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (alive) {
          if (res.ok) {
            const data = (await res.json()) as { run: RunDoc; segments: SessionSegment[] };
            setRun(data.run ?? null);
            setSegments(data.segments ?? []);
            setStatus(data.run?.status ?? "failed");
          } else if (res.status === 404 || res.status === 401) {
            setRun(null); // not found / not owned / signed out — stop after marking loaded
          }
          setLoaded(true);
        }
      } catch {
        // transient — keep the last good state; the next tick retries.
      }
      if (alive && !TERMINAL.includes(statusRef.current)) {
        timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();

    // Reconnect on refocus/bfcache: refetch immediately if not terminal.
    const onFocus = () => {
      if (alive && !TERMINAL.includes(statusRef.current)) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [runId, reload]);

  return { run, segments, status, loaded, refetch };
}
