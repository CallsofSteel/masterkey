// Masterkey × MCP Apps — re-host MCP media outputs to Vercel Blob (MCP_APPS_SPEC.md §5.3 / P1-e).
//
// The MCP run_service/get_result path returns the PROVIDER's media URL (e.g. https://blockrun.ai/…png),
// which (a) expires and (b) is an arbitrary origin the iframe CSP can't allowlist scalably. So when MCP
// Apps is on we re-host each image/video/audio output to OUR Blob store → the viewer loads every media
// result from ONE stable origin (*.public.blob.vercel-storage.com) and the URL is durable for everyone.
//
// Best-effort: never throws; on failure/oversize the caller keeps the provider URL (the viewer then
// shows a download link instead of inline playback). Mirrors from inline base64 when available (no
// re-fetch), else fetches the provider URL.

import { put } from "@vercel/blob";

const MAX_MIRROR_BYTES = 100 * 1024 * 1024; // worker memory guard; larger media keeps its provider URL
const DEFAULT_MIME: Record<string, string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg", file: "application/octet-stream" };
const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg",
  "video/mp4": "mp4", "video/webm": "webm",
  "application/pdf": "pdf", "text/csv": "csv", "text/plain": "txt", "application/json": "json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/zip": "zip",
};

function extFor(mime: string, type: string): string {
  return EXT[mime] ?? EXT[DEFAULT_MIME[type] ?? ""] ?? "bin";
}

/**
 * Re-host one media output to Blob. Returns the Blob URL, or null if it couldn't (no token, oversize,
 * fetch/upload error) — in which case the caller keeps the provider URL. `base64` (when present) is
 * uploaded directly to avoid a re-fetch; otherwise `url` is fetched.
 */
export async function mirrorOutputToBlob(opts: {
  type: "image" | "video" | "audio" | "file";
  url?: string;
  base64?: string;
  mime?: string;
}): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    let buf: Buffer;
    let mime = opts.mime || DEFAULT_MIME[opts.type] || "application/octet-stream";

    if (opts.base64) {
      buf = Buffer.from(opts.base64, "base64");
    } else if (opts.url) {
      const res = await fetch(opts.url);
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_MIRROR_BYTES) return null; // too big — keep provider URL
      buf = Buffer.from(await res.arrayBuffer());
      mime = opts.mime || res.headers.get("content-type")?.split(";")[0] || mime;
    } else {
      return null;
    }

    if (buf.byteLength === 0 || buf.byteLength > MAX_MIRROR_BYTES) return null;

    const blob = await put(`mcp-outputs/${opts.type}.${extFor(mime, opts.type)}`, buf, {
      access: "public",
      contentType: mime,
      addRandomSuffix: true,
    });
    return blob.url;
  } catch {
    return null; // best-effort — caller keeps the provider URL
  }
}
