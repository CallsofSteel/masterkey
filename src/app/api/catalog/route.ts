// GET /api/catalog — the manifest (category tree + summary entries + syncedAt).
// Summary-only (no endpoint URLs / schemas / payment); safe to be public. Rate-limited by src/proxy.ts.
import { NextResponse } from "next/server";
import { getIndex } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getIndex());
}
