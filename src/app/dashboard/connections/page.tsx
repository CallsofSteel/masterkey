"use client";

import { useState } from "react";
import { Plug, Plus, Copy, Check, TriangleAlert, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAccount, fmtDate, type Connection } from "@/lib/account";
import { SPEND_BUCKETS, scopeLabel, type RuleScope } from "@/lib/spend-buckets";
import { PageHeader, SectionCard } from "../_components/ui";

const MCP_URL = "https://www.masterkey.sh/mcp";
const ADD_TO_CLAUDE_URL = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Masterkey&connectorUrl=${encodeURIComponent(MCP_URL)}`;
const CLAUDE_CODE_CMD = `claude mcp add --transport http --scope user masterkey ${MCP_URL}`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Copy"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function ConnectGuide() {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm shadow-black/[0.02]">
      <p className="text-xs text-muted-foreground">
        masterkey.sh/mcp works with any MCP-compatible client (ChatGPT, Cursor, Codex, …)
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {/* Claude (web + desktop) */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Claude Web, Mobile, Desktop</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Connect via Claude.ai and access via Web, Mobile or Claude Desktop</p>
          </div>
          <a
            href={ADD_TO_CLAUDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-80"
          >
            <ExternalLink className="size-3.5" />
            Add to Claude
          </a>
        </div>
        {/* Claude Code */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Claude Code</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Run this once in your terminal, then restart Claude Code and sign in via <code className="font-mono">/mcp</code>.</p>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{CLAUDE_CODE_CMD}</code>
            <CopyButton text={CLAUDE_CODE_CMD} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ScopeBadges({ scopes }: { scopes: RuleScope[] }) {
  if (scopes.includes("all")) return <Badge variant="secondary">Full access</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} variant="outline">
          {scopeLabel(s)}
        </Badge>
      ))}
    </span>
  );
}

function AuthorizeDialog() {
  const { createConnection } = useAccount();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [fullAccess, setFullAccess] = useState(true);
  const [buckets, setBuckets] = useState<Set<RuleScope>>(new Set());
  const [created, setCreated] = useState<{ token: string; connection: Connection } | null>(null);
  const [copied, setCopied] = useState(false);

  function resetForm() {
    setName("");
    setFullAccess(true);
    setBuckets(new Set());
    setCreated(null);
    setCopied(false);
  }

  function toggleBucket(key: RuleScope) {
    setBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const canCreate = name.trim().length > 0 && (fullAccess || buckets.size > 0);

  function authorize() {
    const scopes: RuleScope[] = fullAccess ? ["all"] : [...buckets];
    const result = createConnection({ name: name.trim(), scopes });
    setCreated(result);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Authorize agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Authorization token</DialogTitle>
              <DialogDescription>
                Give this token to <span className="font-medium text-foreground">{created.connection.name}</span> (or
                its MCP config). You won&apos;t be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-2.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{created.token}</code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(created.token);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                Store it now — for your security, Masterkey only shows this token once.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Authorize an agent</DialogTitle>
              <DialogDescription>
                Connect an agent (Claude Code, ChatGPT, your own) over MCP. It spends within the limits you set — no
                wallet or API key for you to manage.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="conn-name">Name</Label>
                <Input
                  id="conn-name"
                  autoFocus
                  placeholder="e.g. Claude Code"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Access</Label>
                <label
                  htmlFor="conn-full-access"
                  className="flex items-center gap-2.5 rounded-lg border border-border p-2.5 text-sm"
                >
                  <input
                    id="conn-full-access"
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={fullAccess}
                    onChange={(e) => setFullAccess(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">Full access</span>
                    <span className="block text-xs text-muted-foreground">Any service in the catalog</span>
                  </span>
                </label>
                {!fullAccess && (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      {SPEND_BUCKETS.map((b) => (
                        <label
                          key={b.key}
                          htmlFor={`bucket-${b.key}`}
                          className="flex items-center gap-2 rounded-md border border-border p-2 text-xs"
                        >
                          <input
                            id={`bucket-${b.key}`}
                            type="checkbox"
                            className="size-3.5 accent-[var(--primary)]"
                            checked={buckets.has(b.key)}
                            onChange={() => toggleBucket(b.key)}
                          />
                          {b.short}
                        </label>
                      ))}
                    </div>
                    {buckets.size === 0 && (
                      <p className="text-xs text-muted-foreground">Select at least one category to authorize.</p>
                    )}
                  </>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!canCreate} onClick={authorize}>
                Authorize
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ connection }: { connection: Connection }) {
  const { revokeConnection } = useAccount();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" />
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke {connection.name}?</DialogTitle>
          <DialogDescription>
            This immediately stops {connection.name} from making any calls. This can&apos;t be undone — you&apos;d need
            to authorize it again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              revokeConnection(connection.id);
              setOpen(false);
            }}
          >
            Revoke access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ConnectionsPage() {
  const { account } = useAccount();
  const { connections } = account;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="Agents and MCP clients authorized to spend on your account. No API keys to manage — they sign in and spend within your limits."
      />

      <ConnectGuide />

      <SectionCard
        title="Connected agents"
        description="Each authorization can be revoked any time."
        action={<AuthorizeDialog />}
      >
        {connections.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-secondary">
              <Plug className="size-5 text-muted-foreground" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">No agents connected</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Authorize an agent to let it call services on your behalf.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {connections.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary">
                  <Plug className="size-4 text-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{c.name}</p>
                    <ScopeBadges scopes={c.scopes} />
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {c.tokenPrefix}_••••{c.last4}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Added {fmtDate(c.createdISO)}
                    {c.lastUsedISO ? ` · Last used ${fmtDate(c.lastUsedISO)}` : " · Never used"}
                  </p>
                </div>
                <RevokeDialog connection={c} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
