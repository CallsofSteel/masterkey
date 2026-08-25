// Masterkey — SIWX (Sign-In-With-X) core (server-only). Signs the merit/`stable*` x402-v2
// "sign-in-with-x" challenge via Sponge's `/api/siwe/generate` and produces the header the upstream
// expects. Reused by `payProvider` (src/lib/wallet.ts) and the job poller (src/lib/mcp/jobs.ts).
//
// Handshake captured live against StableAnalytics + StableEnrich on 2026-06-07 (SIWX_SUPPORT_SPEC.md §3):
//   • Challenge: a 402 whose JSON body carries `extensions["sign-in-with-x"].info` (and is mirrored in
//     the base64 `payment-required` header). `info` hands us EVERYTHING to sign: domain, uri (the EXACT
//     request URL incl. query), version, chainId ("eip155:8453"), type ("eip191"), nonce (server-issued,
//     ~5-min TTL — MUST be echoed), issuedAt, expirationTime, statement.
//   • Reply: header `Sign-In-With-X: base64(JSON.stringify(payload))` where `payload` is the structured
//     object { domain, address, statement, uri, version, chainId, type, nonce, issuedAt, expirationTime,
//     signature }. NOT Sponge's raw `base64SiweMessage` (that's EIP-4361 *text* → "siwx_malformed").
//   • `wallet.paidFetch` forwards this header to the upstream, so pay+SIWX is a single paidFetch call.
//
// NOTE on caching: there is deliberately NO cross-request signature cache. The nonce is server-issued
// per challenge and the signed `uri` includes the full query string, so a cached signature is only ever
// valid for the one exact request that produced its challenge — reuse would be rejected (replay/uri
// mismatch). We always sign fresh from the live challenge (payProvider pre-flights anyway).

import { HttpClient } from "@paysponge/sdk";

/** The SIWX `info` block lifted from a challenge — the inputs needed to sign. */
export type SiwxInfo = {
  domain: string;
  uri: string;
  version?: string;
  chainId?: string; // CAIP-2, e.g. "eip155:8453"
  type?: string; // e.g. "eip191"
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  statement?: string;
};

/** A signed SIWX result ready to attach to the upstream request. */
export type SiwxAuth = {
  headers: Record<string, string>; // e.g. { "Sign-In-With-X": "<base64>" }
  address: string;
  nonce: string;
};

/** Header the merit/stable* family reads the SIWX payload from (override via env if a family differs). */
const SIWX_HEADER = process.env.SIWX_HEADER_NAME || "Sign-In-With-X";

/** SIWX needs an agent key to call Sponge `/api/siwe/generate`; it no-ops on a bare master key. */
export function siwxAvailable(): boolean {
  return !!process.env.SPONGE_API_KEY;
}

// --- challenge detection ----------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Parse a header value that may be raw JSON or base64-encoded JSON. */
function parseMaybeB64Json(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* not raw json */
  }
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Pull a header off a Headers instance or a plain record (case-insensitive). */
function readHeader(headers: Headers | Record<string, string> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string>;
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k];
  return undefined;
}

/** Extract the `sign-in-with-x.info` block from a parsed challenge body/header, if present + usable. */
function extractSiwxInfo(parsed: unknown): SiwxInfo | undefined {
  if (!isRecord(parsed)) return undefined;
  const ext = isRecord(parsed.extensions) ? parsed.extensions : parsed;
  const siwx = isRecord(ext) && isRecord(ext["sign-in-with-x"]) ? (ext["sign-in-with-x"] as Record<string, unknown>) : undefined;
  const info = siwx && isRecord(siwx.info) ? (siwx.info as Record<string, unknown>) : undefined;
  if (!info) return undefined;
  const domain = asStr(info.domain);
  const uri = asStr(info.uri);
  if (!domain || !uri) return undefined;
  return {
    domain,
    uri,
    version: asStr(info.version),
    chainId: asStr(info.chainId),
    type: asStr(info.type),
    nonce: asStr(info.nonce),
    issuedAt: asStr(info.issuedAt),
    expirationTime: asStr(info.expirationTime),
    statement: asStr(info.statement),
  };
}

/**
 * Decide whether a response is a SIWX challenge and, if so, extract the `info` to sign.
 * Primary source: the parsed JSON body's `extensions["sign-in-with-x"].info`. Fallback: the base64
 * `payment-required` header. A bare `error` mentioning SIWX flags `required` even without `info`.
 */
export function detectSiwxChallenge(input: {
  status: number;
  body: unknown;
  headers?: Headers | Record<string, string> | null;
}): { required: boolean; info?: SiwxInfo } {
  const fromBody = extractSiwxInfo(input.body);
  if (fromBody) return { required: true, info: fromBody };

  const hdr = readHeader(input.headers, "payment-required") ?? readHeader(input.headers, "x-payment-required");
  if (hdr) {
    const fromHdr = extractSiwxInfo(parseMaybeB64Json(hdr));
    if (fromHdr) return { required: true, info: fromHdr };
  }

  if (isRecord(input.body)) {
    const err = asStr(input.body.error) ?? asStr(input.body.message);
    if (err && /siwx|sign[-\s]?in[-\s]?with[-\s]?x/i.test(err)) return { required: true };
  }
  return { required: false };
}

// --- signing ----------------------------------------------------------------------------------

/**
 * Sign a SIWX challenge. Calls Sponge `/api/siwe/generate` to sign with the master wallet, then builds
 * the structured base64 payload the upstream expects and returns it as the `Sign-In-With-X` header.
 * Returns `null` (never throws) when SIWX is unavailable, the info is unusable, or signing fails —
 * callers treat null as "couldn't SIWX" and surface a clear error / fall through.
 */
export async function signSiwx(info: SiwxInfo): Promise<SiwxAuth | null> {
  const apiKey = process.env.SPONGE_API_KEY;
  if (!apiKey) return null;
  if (!info?.domain || !info?.uri) return null;
  try {
    const http = new HttpClient({ apiKey, baseUrl: process.env.SPONGE_API_URL || undefined });
    const chainNum = info.chainId ? Number(String(info.chainId).split(":").pop()) : undefined;
    const siwe = (await http.post("/api/siwe/generate", {
      domain: info.domain,
      uri: info.uri,
      ...(info.nonce ? { nonce: info.nonce } : {}),
      ...(info.statement ? { statement: info.statement } : {}),
      ...(chainNum && Number.isFinite(chainNum) ? { chain_id: chainNum } : {}),
      ...(info.expirationTime ? { expiration_time: info.expirationTime } : {}),
    })) as Record<string, unknown>;

    const address = asStr(siwe.address);
    const signature = asStr(siwe.signature);
    if (!address || !signature) return null;

    const nonce = info.nonce ?? asStr(siwe.nonce);
    const payload = {
      domain: info.domain,
      address,
      statement: info.statement,
      uri: info.uri,
      version: info.version ?? asStr(siwe.version) ?? "1",
      chainId: info.chainId ?? "eip155:8453",
      type: info.type ?? "eip191",
      nonce,
      issuedAt: asStr(siwe.issuedAt) ?? info.issuedAt,
      expirationTime: asStr(siwe.expirationTime) ?? info.expirationTime,
      signature,
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    return { headers: { [SIWX_HEADER]: b64 }, address, nonce: nonce ?? "" };
  } catch {
    return null;
  }
}

/**
 * Convenience: given a (parsed body, headers, status) challenge, detect + sign in one call.
 * Returns null if it isn't a SIWX challenge or signing failed.
 */
export async function signSiwxFromChallenge(input: {
  status: number;
  body: unknown;
  headers?: Headers | Record<string, string> | null;
}): Promise<SiwxAuth | null> {
  const det = detectSiwxChallenge(input);
  if (!det.required || !det.info) return null;
  return signSiwx(det.info);
}
