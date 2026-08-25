// Masterkey — RFC 8414 Authorization Server Metadata. MCP clients fetch this (cross-origin) to
// discover /authorize, /token, /register. See MCP_SPEC.md M2 + Appendix R1.

import { NextResponse } from "next/server";
import { authServerMetadata } from "@/lib/oauth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  return NextResponse.json(authServerMetadata(), { headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
