// Masterkey — OAuth consent screen (server component; native form POST → /api/oauth/authorize/consent).
// No client JS required. See MCP_SPEC.md M2.

import { SPEND_BUCKETS } from "@/lib/spend-buckets";

export function ConsentForm(props: {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resource: string;
}) {
  const { clientId, clientName, redirectUri, scope, state, codeChallenge, resource } = props;
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="font-heading text-2xl text-foreground">Authorize {clientName}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong className="text-foreground">{clientName}</strong> wants to call Masterkey services on
          your behalf. Masterkey pays providers and the cost counts against your existing spend limits —
          the app never sees a wallet or your card.
        </p>

        <form method="POST" action="/api/oauth/authorize/consent" className="mt-5 space-y-4">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="resource" value={resource} />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Allowed categories</legend>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" name="buckets" value="all" defaultChecked />
              Everything (all categories)
            </label>
            <div className="ml-1 space-y-1.5 border-l border-border pl-3">
              {SPEND_BUCKETS.map((b) => (
                <label key={b.key} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" name="buckets" value={b.key} />
                  {b.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Leave “Everything” checked for full access, or pick specific categories.
            </p>
          </fieldset>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="submit"
              name="decision"
              value="deny"
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Deny
            </button>
            <button
              type="submit"
              name="decision"
              value="approve"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Approve
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
