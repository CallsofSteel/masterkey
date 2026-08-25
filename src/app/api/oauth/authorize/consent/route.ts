// Masterkey — OAuth consent submission. The signed-in resource owner approves/denies an MCP
// client's request; on approve we create the connection + a PKCE auth code and redirect back to
// the client. See MCP_SPEC.md M2.

import { NextResponse } from "next/server";
import type { RuleScope } from "@/lib/spend-buckets";
import { SPEND_BUCKETS } from "@/lib/spend-buckets";
import { getSessionUserId } from "@/lib/session";
import { getClient, upsertConnection, createAuthCode } from "@/lib/oauth/store";
import { MCP_RESOURCE_URL, normalizeScope } from "@/lib/oauth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET_KEYS = SPEND_BUCKETS.map((b) => b.key) as string[];

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const scope = get("scope");
  const codeChallenge = get("code_challenge");
  const resource = get("resource");
  const decision = get("decision");
  const buckets = form.getAll("buckets").filter((b): b is string => typeof b === "string");

  // Validate client + redirect before redirecting anywhere.
  const client = clientId ? await getClient(clientId) : null;
  if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request", error_description: "invalid client/redirect" }, { status: 400 });
  }

  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    return NextResponse.redirect(u.toString(), 303);
  };

  if (decision !== "approve") return back({ error: "access_denied" });

  const userId = await getSessionUserId();
  if (!userId) return back({ error: "access_denied", error_description: "not signed in" });
  if (!codeChallenge || resource !== MCP_RESOURCE_URL) {
    return back({ error: "invalid_request" });
  }

  // Map chosen buckets → connection spend scopes (none/all → everything).
  const scopes: RuleScope[] =
    !buckets.length || buckets.includes("all")
      ? ["all"]
      : (buckets.filter((b) => BUCKET_KEYS.includes(b)) as RuleScope[]);

  const connection = await upsertConnection({
    userId,
    clientId: client._id,
    name: client.clientName || "MCP client",
    scopes: scopes.length ? scopes : ["all"],
  });

  const code = await createAuthCode({
    clientId: client._id,
    userId,
    connectionId: connection._id,
    redirectUri,
    scope: normalizeScope(scope),
    audience: MCP_RESOURCE_URL,
    codeChallenge,
  });

  return back({ code });
}
