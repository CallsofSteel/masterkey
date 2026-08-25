// Masterkey — OAuth 2.1 authorization endpoint (consent screen). Validates the request, gates on
// the first-party CDP session, and renders consent (or a sign-in gate). See MCP_SPEC.md M2 + R1.

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { getClient } from "@/lib/oauth/store";
import { MCP_RESOURCE_URL } from "@/lib/oauth/config";
import { ConsentForm } from "./consent-form";
import { SignInGate } from "./sign-in-gate";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

function ErrorScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <h1 className="font-heading text-2xl text-foreground">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const responseType = one(sp.response_type);
  const scope = one(sp.scope);
  const state = one(sp.state);
  const codeChallenge = one(sp.code_challenge);
  const codeChallengeMethod = one(sp.code_challenge_method);
  const resource = one(sp.resource);

  // Validate client + redirect first — errors here cannot safely redirect back.
  const client = clientId ? await getClient(clientId) : null;
  if (!client) {
    return <ErrorScreen title="Invalid request" detail="Unknown or missing client_id." />;
  }
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return <ErrorScreen title="Invalid redirect_uri" detail="This redirect_uri is not registered for the client." />;
  }

  // From here, parameter errors redirect back to the client per OAuth.
  const back = (error: string, description?: string): never => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (description) u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };
  if (responseType !== "code") back("unsupported_response_type", "response_type must be 'code'");
  if (!codeChallenge || codeChallengeMethod !== "S256") back("invalid_request", "PKCE with S256 is required");
  if (resource !== MCP_RESOURCE_URL) back("invalid_target", "resource must be the MCP server URL");

  // Resource owner must be signed in (first-party CDP session).
  const userId = await getSessionUserId();
  if (!userId) return <SignInGate />;

  return (
    <ConsentForm
      clientId={clientId}
      clientName={client.clientName || "An application"}
      redirectUri={redirectUri}
      scope={scope}
      state={state}
      codeChallenge={codeChallenge}
      resource={resource}
    />
  );
}
