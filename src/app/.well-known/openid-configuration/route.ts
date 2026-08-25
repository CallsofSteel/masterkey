// Masterkey — OpenID-style alias for AS metadata. Some MCP clients probe /.well-known/
// openid-configuration as a fallback (Appendix R1). Serves the same RFC 8414 document.

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
