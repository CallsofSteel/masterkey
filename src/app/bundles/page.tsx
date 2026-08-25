"use client";

// Masterkey — Bundle Library (spec §4). Curated + the signed-in user's own bundles as cards, with a
// favorites filter, search, and per-card actions (Run via "/", Open in builder, Export, Favorite,
// Duplicate, Delete). Anonymous users see curated only. Lists from GET /api/studio/bundles (§5.1).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Star,
  Play,
  PenLine,
  Download,
  Copy,
  Check,
  Trash2,
  Plus,
  Loader2,
  Search,
  FileText,
  FileJson,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAccount } from "@/lib/account";
import { useSignInGate } from "@/components/auth/sign-in-gate";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtDate } from "@/lib/account";
import type { ApiBundle } from "@/lib/studio/serialize";

type Tab = "all" | "favorites" | "mine" | "curated";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "favorites", label: "Favorites" },
  { key: "mine", label: "Mine" },
  { key: "curated", label: "Curated" },
];

function SourceBadge({ b }: { b: ApiBundle }) {
  const label = b.source === "curated" ? "Curated" : b.source === "quick" ? "Quick" : "Studio";
  return (
    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{label}</span>
  );
}

function StatusBadge({ b }: { b: ApiBundle }) {
  if (b.status === "ready")
    return (
      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        tested ✓{b.lastTestedISO ? ` ${fmtDate(b.lastTestedISO)}` : ""}
      </span>
    );
  return <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">draft</span>;
}

export default function BundleLibraryPage() {
  const router = useRouter();
  const { signedIn } = useAccount();
  const gate = useSignInGate();
  const [bundles, setBundles] = useState<ApiBundle[] | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiBundle | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/studio/bundles", { cache: "no-store" });
      const data = await res.json();
      setBundles(Array.isArray(data.bundles) ? data.bundles : []);
    } catch {
      setBundles([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/studio/bundles", { cache: "no-store" });
        const data = await res.json();
        if (alive) setBundles(Array.isArray(data.bundles) ? data.bundles : []);
      } catch {
        if (alive) setBundles([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const filtered = useMemo(() => {
    let list = bundles ?? [];
    if (tab === "favorites") list = list.filter((b) => b.favorite);
    else if (tab === "mine") list = list.filter((b) => b.mine);
    else if (tab === "curated") list = list.filter((b) => b.source === "curated");
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((b) => (b.name + " " + b.description + " " + b.slug).toLowerCase().includes(needle));
    // favorites first, then newest
    return [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.updatedISO > a.updatedISO ? 1 : -1));
  }, [bundles, tab, q]);

  const run = useCallback(
    async (b: ApiBundle) => {
      if (!gate.ensureSignedIn()) return;
      setBusy(b.id);
      try {
        // Own + curated bundles resolve by "/slug" (own-then-curated). A SHARED bundle (another user's,
        // surfaced in "All") doesn't resolve by slug — run it by id (server allows only public/ready ones).
        const payload = b.mine || b.source === "curated" ? { goal: `/${b.slug}` } : { goal: `/${b.slug}`, bundleId: b.id };
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.runId) router.push(`/run/${data.runId}`);
      } finally {
        setBusy(null);
      }
    },
    [gate, router],
  );

  const toggleFavorite = useCallback(
    async (b: ApiBundle) => {
      if (!gate.ensureSignedIn()) return;
      // optimistic
      setBundles((prev) => prev?.map((x) => (x.id === b.id ? { ...x, favorite: !x.favorite } : x)) ?? prev);
      await fetch(`/api/studio/bundles/${b.id}/favorite`, { method: "POST" }).catch(() => {});
    },
    [gate],
  );

  const duplicate = useCallback(
    async (b: ApiBundle) => {
      if (!gate.ensureSignedIn()) return;
      setBusy(b.id);
      try {
        await fetch("/api/studio/bundles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Copy of ${b.name}`, description: b.description, trigger: b.trigger, nodes: b.nodes, edges: b.edges, inputs: b.inputs }),
        });
        await reload();
      } finally {
        setBusy(null);
      }
    },
    [gate, reload],
  );

  // Delete uses our own confirm modal (not a browser alert).
  const requestDelete = useCallback(
    (b: ApiBundle) => {
      if (!gate.ensureSignedIn()) return;
      setDeleteTarget(b);
    },
    [gate],
  );
  const confirmDelete = useCallback(async () => {
    const b = deleteTarget;
    if (!b) return;
    setDeleteTarget(null);
    setBusy(b.id);
    try {
      await fetch(`/api/studio/bundles/${b.id}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(null);
    }
  }, [deleteTarget, reload]);

  const exportBundle = useCallback(async (b: ApiBundle, format: "skill" | "json") => {
    const res = await fetch(`/api/studio/bundles/${b.id}/export?format=${format}`, { method: "POST" });
    const text = format === "json" ? JSON.stringify(await res.json(), null, 2) : await res.text();
    const blob = new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = format === "json" ? `${b.slug}.bundle.json` : `${b.slug}.skill.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // §11.2: copy the SKILL.md markdown to the clipboard (with brief per-card feedback).
  const copyMarkdown = useCallback(async (b: ApiBundle) => {
    try {
      const res = await fetch(`/api/studio/bundles/${b.id}/export?format=skill`, { method: "POST" });
      await navigator.clipboard.writeText(await res.text());
      setCopiedId(b.id);
      setTimeout(() => setCopiedId((c) => (c === b.id ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="size-5" /></Link>
          <div>
            <h1 className="text-lg font-semibold">Bundle Library</h1>
            <p className="text-sm text-muted-foreground">Reusable multi-step recipes. Run them with <code className="font-mono">/</code>, edit in the builder, or export.</p>
          </div>
        </div>
        <Button size="sm" onClick={() => { if (gate.ensureSignedIn()) router.push("/bundles/new"); }}>
          <Plus className="size-4" /> New bundle
        </Button>
      </div>

      {/* tabs + search */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.key ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bundles…"
            className="h-8 w-56 rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      {bundles === null ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <p className="text-sm font-medium">No bundles here yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create one in the visual builder, or describe a goal and let Masterkey assemble it.
          </p>
          <Button size="sm" onClick={() => { if (gate.ensureSignedIn()) router.push("/bundles/new"); }}>
            <Plus className="size-4" /> New bundle
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((b) => {
            const own = b.mine;
            const isBusy = busy === b.id;
            return (
              <div key={b.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{b.description || "No description"}</p>
                  </div>
                  <button onClick={() => toggleFavorite(b)} className="shrink-0 text-muted-foreground hover:text-amber-500" aria-label="Favorite">
                    <Star className={cn("size-4", b.favorite && "fill-amber-400 text-amber-500")} />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <SourceBadge b={b} />
                  <StatusBadge b={b} />
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">/{b.slug}</code>
                  <span className="text-[10px] text-muted-foreground">· {fmtDate(b.updatedISO || b.createdISO)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="default" disabled={isBusy} onClick={() => run(b)}>
                    {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => router.push(`/bundles/${b.id}/edit`)}>
                    <PenLine className="size-3.5" /> {own ? "Edit" : "Open"}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" title="Export">
                        {copiedId === b.id ? <Check className="size-3.5 text-emerald-500" /> : <Download className="size-3.5" />}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => exportBundle(b, "skill")}>
                        <FileText className="size-3.5" /> Download SKILL.md
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportBundle(b, "json")}>
                        <FileJson className="size-3.5" /> Download bundle .json
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => copyMarkdown(b)}>
                        <Copy className="size-3.5" /> Copy markdown
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(b)} title="Duplicate">
                    <Copy className="size-3.5" />
                  </Button>
                  {own && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => requestDelete(b)} title="Delete">
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleteTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this bundle and its graph. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SignInDialog {...gate.dialogProps} />
    </div>
  );
}
