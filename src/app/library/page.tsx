"use client";

// Masterkey — /library (W10): per-user gallery of saved outputs + recent runs. Reopen a run (replay
// run_steps via /run/[id]), re-download an output, resume a still-awaiting_approval run. Anonymous →
// sign-in (W1). Outputs are mirrored to Blob on run completion (Track B) so their URLs stay valid.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, FileText, ExternalLink } from "lucide-react";
import type { RunDoc, RunAssetDoc, RunStatus } from "@/lib/chat/types";
import { useSignInGate } from "@/components/auth/sign-in-gate";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/account";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  complete: "Complete",
  failed: "Failed",
  capped: "Capped",
  canceled: "Canceled",
};

function fmtCost(n?: number): string {
  if (n == null || n <= 0) return "$0.00";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export default function LibraryPage() {
  const gate = useSignInGate();
  const [data, setData] = useState<{ runs: RunDoc[]; outputs: RunAssetDoc[] } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!gate.signedIn) return;
    let alive = true;
    fetch("/api/library", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) {
          setData(d as { runs: RunDoc[]; outputs: RunAssetDoc[] } | null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [gate.signedIn]);

  if (!gate.loading && !gate.signedIn) {
    return (
      <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">Sign in to view your library.</p>
        <Button onClick={gate.openSignIn}>Sign in</Button>
        <SignInDialog {...gate.dialogProps} />
      </main>
    );
  }

  const runs = data?.runs ?? [];
  const outputs = data?.outputs ?? [];

  return (
    <main className="mx-auto min-h-svh max-w-4xl p-4">
      <header className="mb-4 border-b pb-3">
        <Link href="/" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> Back to catalog
        </Link>
        <h1 className="text-lg font-semibold text-foreground">Your library</h1>
      </header>

      {!loaded ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-8">
          {/* Saved outputs */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-foreground">Saved outputs</h2>
            {outputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved outputs yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {outputs.map((o) => (
                  <a
                    key={o._id}
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group block overflow-hidden rounded-lg border bg-card"
                    title={o.mime}
                  >
                    {o.mime.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.url} alt={o.mime} className="aspect-square w-full object-cover" />
                    ) : (
                      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                        <FileText className="size-6" />
                        <span className="px-1 text-[10px]">{o.mime}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-1 px-2 py-1 text-[10px] text-muted-foreground">
                      <span>{fmtDate(o.createdISO)}</span>
                      <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </a>
                ))}
              </div>
            )}
          </section>

          {/* Recent runs */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-foreground">Recent runs</h2>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet — describe a goal on the catalog to start one.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {runs.map((r) => (
                  <li key={r._id}>
                    <Link href={`/run/${r._id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-accent/50">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.title || r.goal}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{fmtCost(r.providerCostUsd)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[r.status]}</span>
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{fmtDate(r.updatedISO)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
