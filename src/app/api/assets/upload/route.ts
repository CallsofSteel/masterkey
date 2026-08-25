// Masterkey — POST /api/assets/upload (W3). Session-gated. Accepts a multipart/form-data `file`
// (+ optional `serviceId` to scope allowed MIME to that service's modality.input), stores it on
// Vercel Blob (public URL), records a RunAssetDoc(kind:"input"), and returns { url, mime, bytes }.
// We pass URLs (not base64) into the run. Server route → 4.5MB cap (larger = client-upload, later).

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getSessionUserId } from "@/lib/session";
import { findServiceById } from "@/lib/registry";
import { recordAsset } from "@/lib/chat/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 4.5 * 1024 * 1024; // Vercel server-route body cap

// Map a service modality.input token → allowed MIME prefixes. Images are ALWAYS allowed.
const MOD_TO_MIME: Record<string, string[]> = {
  image: ["image/"],
  audio: ["audio/"],
  video: ["video/"],
  text: ["text/", "application/pdf"],
  json: ["application/json", "text/"],
  file: ["application/", "text/", "image/", "audio/", "video/"],
  document: ["application/pdf", "text/", "application/"],
};
const GENERAL_PREFIXES = ["image/", "audio/", "video/", "text/", "application/pdf", "application/json"];

function allowedPrefixes(serviceId: string | null): string[] {
  const set = new Set<string>(["image/"]);
  if (serviceId) {
    const svc = findServiceById(serviceId);
    for (const m of svc?.modality?.input ?? []) {
      for (const p of MOD_TO_MIME[m.toLowerCase()] ?? []) set.add(p);
    }
    // If the seed service declared no usable input modality, fall back to the general set.
    if (set.size === 1) GENERAL_PREFIXES.forEach((p) => set.add(p));
  } else {
    GENERAL_PREFIXES.forEach((p) => set.add(p));
  }
  return [...set];
}

function sanitizeName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").slice(-100);
  return base || "upload";
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${(file.size / 1_048_576).toFixed(1)}MB > 4.5MB limit)` },
      { status: 413 },
    );
  }

  const serviceId = typeof form.get("serviceId") === "string" ? (form.get("serviceId") as string) : null;
  const mime = file.type || "application/octet-stream";
  const allowed = allowedPrefixes(serviceId);
  if (!allowed.some((p) => mime.startsWith(p))) {
    return NextResponse.json(
      { error: `unsupported file type "${mime}". Allowed: ${allowed.join(", ")}` },
      { status: 415 },
    );
  }

  let url: string;
  try {
    const blob = await put(`inputs/${sanitizeName(file.name)}`, file, {
      access: "public",
      contentType: mime,
      addRandomSuffix: true,
    });
    url = blob.url;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `upload failed: ${e.message}` : "upload failed" },
      { status: 502 },
    );
  }

  await recordAsset({ userId, kind: "input", url, mime, bytes: file.size, ...(serviceId ? { serviceId } : {}) });
  return NextResponse.json({ url, mime, bytes: file.size });
}
