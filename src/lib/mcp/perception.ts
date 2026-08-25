// Masterkey — output perception helpers (OUTPUT_AWARENESS_SPEC.md). These make a generated output
// something the MODEL can perceive AND the host can DISPLAY: download the bytes once, normalize/downscale
// images to JPEG, extract text from a PDF. Used by mapOutput in run.ts. Pure + best-effort (never throw
// into the run pipeline). See also media-mirror.ts (durable Blob copy, the USER-facing artifact).
//
// Image processing uses `sharp` (decodes png/jpeg/gif/webp/avif/tiff; already bundled by Next for image
// optimization). We normalize to JPEG because claude.ai does NOT reliably display image/webp (or avif)
// content blocks / widgets — observed live: webp outputs returned text only, no image; the same images as
// JPEG render fine.

import sharp from "sharp";

// Generous fetch cap: large enough to download a full-res generated image/doc for previewing + mirroring,
// while skipping anything absurd (huge video). The OLD ~750KB inline cap dropped most real images before
// the model could ever see them; this fetches them so we can downscale a preview + mirror.
export const MEDIA_FETCH_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Download media bytes ONCE, with retry/backoff (a freshly-generated CDN URL can 404 for a few seconds
 * during edge propagation), an abort timeout, and a size guard. Returns the raw buffer + the response
 * content-type (lowercased, no params), or undefined on failure/oversize. Callers reuse the buffer for
 * BOTH inline-preview and Blob mirroring so the bytes are fetched only once.
 */
export async function fetchMediaBytes(
  url: string,
  maxBytes: number = MEDIA_FETCH_MAX_BYTES,
): Promise<{ buffer: Buffer; contentType: string } | undefined> {
  const backoffMs = [0, 1000, 2000, 3000];
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt]) await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue; // transient (e.g. 404 propagation) → retry
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) return undefined; // too big — skip before buffering
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) continue;
      if (buffer.length > maxBytes) return undefined;
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      return { buffer, contentType };
    } catch {
      // network error / abort → retry
    }
  }
  return undefined;
}

// Image formats claude.ai reliably DISPLAYS in an MCP result (content block + widget) AND the model's
// vision ingests. webp/avif are deliberately EXCLUDED — claude.ai shows text-only for those (verified
// live) — so we convert them to JPEG via normalizeToJpeg before inlining/mirroring.
const DISPLAYABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif"]);
export function isDisplayableImageMime(mime?: string): boolean {
  return !!mime && DISPLAYABLE_IMAGE_MIMES.has(mime);
}

/**
 * Convert any sharp-decodable image (incl. webp/avif) to a JPEG buffer at a sane size — used to normalize
 * non-displayable formats so claude renders them everywhere (content block + widget). Returns undefined
 * if sharp can't decode it (caller keeps the original).
 */
export async function normalizeToJpeg(
  buffer: Buffer,
  maxDim = 2048,
  quality = 86,
): Promise<Buffer | undefined> {
  try {
    return await sharp(buffer).rotate().resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  } catch {
    return undefined;
  }
}

/**
 * Downscale an image into an inline-able JPEG preview the model CAN see, under `maxBase64Bytes`. Returns
 * base64 JPEG or undefined if undecodable / can't fit. Progressive shrink. (Used when the image is too big
 * to inline as-is.)
 */
export async function downscaleImageForInline(
  buffer: Buffer,
  maxBase64Bytes = 900_000,
): Promise<{ data: string; mime: string } | undefined> {
  const attempts: Array<{ dim: number; quality: number }> = [
    { dim: 1024, quality: 72 },
    { dim: 768, quality: 65 },
    { dim: 512, quality: 60 },
    { dim: 384, quality: 50 },
  ];
  for (const a of attempts) {
    try {
      const out = await sharp(buffer).rotate().resize(a.dim, a.dim, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: a.quality }).toBuffer();
      const data = out.toString("base64");
      if (data.length <= maxBase64Bytes) return { data, mime: "image/jpeg" };
    } catch {
      return undefined; // undecodable → caller keeps the URL
    }
  }
  return undefined; // couldn't fit even at the smallest setting
}

/**
 * Extract text from a PDF buffer so the model can READ a generated document. Returns the text, truncated
 * to `maxChars` (the full file stays at its URL), or undefined if there's no extractable text (e.g. a
 * scanned/image-only PDF — that would need OCR) or on any error. Dynamic-imports `unpdf` (pdf.js) so the
 * heavy parser only loads when a PDF actually appears.
 */
export async function extractPdfText(buffer: Buffer, maxChars = 12_000): Promise<string | undefined> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    const full = (Array.isArray(text) ? text.join("\n") : text).replace(/\s+\n/g, "\n").trim();
    if (!full) return undefined;
    return full.length > maxChars ? `${full.slice(0, maxChars)}\n…[truncated — full document at the link]` : full;
  } catch {
    return undefined;
  }
}
