// Masterkey — output mirroring to Vercel Blob on run completion (WEB_SPEC W10, line 327 / §0).
// Provider media URLs expire, so a durable library can't point at them. On a terminal-success run we
// re-host each media output (image/video/audio) to Blob and record a RunAssetDoc(kind:"output") that
// the library reads. Best-effort + idempotent: a crash-replay that re-reaches completion skips outputs
// already mirrored (dedup on the original provider URL via RunAssetDoc.sourceUrl). Runs in the durable
// worker (the brain's completion path), so failures here never fail the run.

import { put } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { COLLECTIONS } from "@/lib/mcp/types";
import { getSteps, recordAsset } from "@/lib/chat/db";
import type { RunResult } from "@/lib/mcp/types";
import type { RunAssetDoc } from "@/lib/chat/types";

const MIRRORABLE = new Set(["image", "video", "audio"]);
const DEFAULT_MIME: Record<string, string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };
const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg",
  "video/mp4": "mp4", "video/webm": "webm",
};
const MAX_MIRROR_BYTES = 100 * 1024 * 1024; // skip absurdly large blobs (worker memory guard)

function extFor(mime: string, type: string): string {
  return EXT[mime] ?? EXT[DEFAULT_MIME[type] ?? ""] ?? "bin";
}

/**
 * Mirror a run's media outputs to Blob + record them for the library. Idempotent (skips already-mirrored
 * source URLs). Returns the number of NEW assets recorded. Never throws (best-effort per asset).
 */
export async function mirrorRunOutputs(runId: string, userId: string): Promise<number> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 0; // no Blob configured → no-op (e.g. local without token)

  let recorded = 0;
  try {
    const db = await getDb();
    const existing = await db
      .collection<RunAssetDoc>(COLLECTIONS.runAssets)
      .find({ runId, kind: "output" })
      .toArray();
    const done = new Set(existing.map((a) => a.sourceUrl).filter((s): s is string => !!s));

    const steps = await getSteps(runId);
    for (const s of steps) {
      if (s.kind !== "result") continue;
      const rr = (s.data as { structured?: RunResult } | undefined)?.structured;
      const outputs = rr?.outputs;
      if (!Array.isArray(outputs)) continue;

      for (const o of outputs) {
        if (!MIRRORABLE.has(o.type)) continue;

        // Two output shapes: a provider URL (the common, expiring case) or inline base64 `data`.
        if (o.url) {
          if (done.has(o.url)) continue;
          try {
            const res = await fetch(o.url);
            if (!res.ok) continue;
            const len = Number(res.headers.get("content-length") ?? "0");
            if (len > MAX_MIRROR_BYTES) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.byteLength > MAX_MIRROR_BYTES) continue;
            const mime = o.mime || res.headers.get("content-type")?.split(";")[0] || DEFAULT_MIME[o.type] || "application/octet-stream";
            const blob = await put(`outputs/${runId}/asset.${extFor(mime, o.type)}`, buf, {
              access: "public",
              contentType: mime,
              addRandomSuffix: true,
            });
            await recordAsset({ userId, runId, kind: "output", url: blob.url, sourceUrl: o.url, mime, bytes: buf.byteLength, ...(rr?.serviceId ? { serviceId: rr.serviceId } : {}) });
            done.add(o.url);
            recorded++;
          } catch {
            /* best-effort per asset — skip on fetch/upload failure */
          }
        } else if (o.data) {
          // Inline base64 → mirror to Blob too (don't leave media only in the Mongo doc). Dedup by a
          // synthetic source marker so a replay doesn't re-upload.
          const marker = `b64:${o.type}:${o.data.length}:${o.data.slice(0, 24)}`;
          if (done.has(marker)) continue;
          try {
            const buf = Buffer.from(o.data, "base64");
            if (buf.byteLength === 0 || buf.byteLength > MAX_MIRROR_BYTES) continue;
            const mime = o.mime || DEFAULT_MIME[o.type] || "application/octet-stream";
            const blob = await put(`outputs/${runId}/asset.${extFor(mime, o.type)}`, buf, {
              access: "public",
              contentType: mime,
              addRandomSuffix: true,
            });
            await recordAsset({ userId, runId, kind: "output", url: blob.url, sourceUrl: marker, mime, bytes: buf.byteLength, ...(rr?.serviceId ? { serviceId: rr.serviceId } : {}) });
            done.add(marker);
            recorded++;
          } catch {
            /* best-effort */
          }
        }
      }
    }
  } catch {
    /* never fail the run on mirroring */
  }
  return recorded;
}
