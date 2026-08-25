// Masterkey — POST /api/bundle. Given selected serviceIds, loads the FULL registry detail for each
// (server-only loader; hidden services/backends already filtered) and returns the raw bundle in both
// shapes: `markdown` (copy-to-clipboard) + `bundle` (downloadable JSON). Open access — this is registry
// data also reachable via /api/subcat; rate-limited by proxy.ts. No AI here (see /api/bundle/skill).

import { NextResponse } from "next/server";
import { findServiceById } from "@/lib/registry";
import { buildBundle, bundleToMarkdown } from "@/lib/bundle/format";
import type { Service } from "@/data/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SERVICES = 40;

export async function POST(req: Request) {
  let body: { serviceIds?: unknown };
  try {
    body = (await req.json()) as { serviceIds?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const ids = Array.isArray(body.serviceIds)
    ? [...new Set(body.serviceIds.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x)))]
    : [];
  if (!ids.length) return NextResponse.json({ error: "serviceIds is required" }, { status: 400 });
  if (ids.length > MAX_SERVICES) return NextResponse.json({ error: `too many services (max ${MAX_SERVICES})` }, { status: 400 });

  const services = ids.map(findServiceById).filter((s): s is Service => !!s);
  if (!services.length) return NextResponse.json({ error: "no matching services" }, { status: 404 });

  const bundle = buildBundle(services);
  const markdown = bundleToMarkdown(bundle);
  const missing = ids.filter((id) => !services.some((s) => s.id === id));

  return NextResponse.json({ bundle, markdown, missing });
}
