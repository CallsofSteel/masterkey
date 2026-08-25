"use client";

// Masterkey — Bundle Creator action bar (All-view selection mode). Floats at the bottom while the user
// multi-selects services (photo-library style). Lets them: copy the raw bundle (Markdown) / download it
// (JSON) — both open to all via /api/bundle (§12.5) — and, after writing a goal, GENERATE A RUNNABLE
// BUNDLE via /api/studio/generate (sign-in gated; spends the platform Anthropic key). Generate drafts a
// graph, SAVES it to the library (spec §12.1), and the result card lets the user Run it, Open it in the
// builder (§12.2), or Export it (SKILL.md / .json / copy). A too-vague goal returns an ask-first message.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Package, X, Copy, Check, Download, Sparkles, Loader2, Trash2, Play, PenLine, FileText, FileJson, Lightbulb, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSignInGate } from "@/components/auth/sign-in-gate";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import type { EntrySummary } from "@/data/types";
import type { ApiBundle } from "@/lib/studio/serialize";

type GenerateResult =
  | { mode: "bundle"; bundle: ApiBundle; reply?: string }
  | { mode: "needs_confirmation"; message: string };

function download(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BundleBar({
  selected,
  onRemove,
  onClear,
}: {
  selected: EntrySummary[];
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Reserved (previously lifted registry-proposed additions); the graph brain now picks services itself. */
  onAddServices?: (ids: string[]) => void;
}) {
  const gate = useSignInGate();
  const router = useRouter();
  const ids = selected.map((s) => s.id);

  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "copy" | "download" | "generate" | "run" | "export">(null);
  const [error, setError] = useState<string | null>(null);

  // Result of Generate: the saved bundle (opens the success dialog), or an ask-first clarifying message.
  const [created, setCreated] = useState<{ bundle: ApiBundle; reply?: string } | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [exportCopied, setExportCopied] = useState(false);

  const fetchBundle = useCallback(async () => {
    const res = await fetch("/api/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceIds: ids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "bundle failed");
    return (await res.json()) as { bundle: unknown; markdown: string };
  }, [ids]);

  const onCopy = useCallback(async () => {
    setError(null);
    setBusy("copy");
    try {
      const { markdown } = await fetchBundle();
      await navigator.clipboard?.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "copy failed");
    } finally {
      setBusy(null);
    }
  }, [fetchBundle]);

  const onDownload = useCallback(async () => {
    setError(null);
    setBusy("download");
    try {
      const { bundle } = await fetchBundle();
      download("masterkey-bundle.json", JSON.stringify(bundle, null, 2), "application/json");
    } catch (e) {
      setError(e instanceof Error ? e.message : "download failed");
    } finally {
      setBusy(null);
    }
  }, [fetchBundle]);

  // Generate a runnable bundle from the selection + goal (§12.1). Saves it to the library and opens the
  // success dialog; a too-vague goal returns an ask-first message instead.
  const generate = useCallback(async () => {
    setError(null);
    if (!prompt.trim()) {
      setError("Describe what you want this bundle to do.");
      return;
    }
    if (!gate.ensureSignedIn()) return; // opens the sign-in dialog
    setBusy("generate");
    try {
      const res = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceIds: ids, prompt: prompt.trim() }),
      });
      const raw = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
      if (!res.ok || raw.error) throw new Error(typeof raw.error === "string" ? raw.error : "generation failed");
      const data = raw as unknown as GenerateResult;
      if (data.mode === "needs_confirmation") {
        setClarify(data.message);
        return;
      }
      setCreated({ bundle: data.bundle, reply: data.reply });
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setBusy(null);
    }
  }, [prompt, ids, gate]);

  // Run the saved bundle inside Masterkey (durable run via "/<slug>").
  const runCreated = useCallback(async () => {
    if (!created) return;
    setBusy("run");
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: `/${created.bundle.slug}` }),
      });
      const data = await res.json();
      if (data.runId) router.push(`/run/${data.runId}`);
      else setError(data.error || "Failed to start run");
    } catch {
      setError("Failed to start run");
    } finally {
      setBusy(null);
    }
  }, [created, router]);

  // Export the saved bundle (§11.2): SKILL.md / .json download or copy markdown.
  const exportCreated = useCallback(
    async (format: "skill" | "json" | "copy") => {
      if (!created) return;
      setBusy("export");
      try {
        const res = await fetch(`/api/studio/bundles/${created.bundle.id}/export?format=${format === "json" ? "json" : "skill"}`, { method: "POST" });
        const text = format === "json" ? JSON.stringify(await res.json(), null, 2) : await res.text();
        if (format === "copy") {
          await navigator.clipboard?.writeText(text);
          setExportCopied(true);
          setTimeout(() => setExportCopied(false), 1500);
        } else {
          download(format === "json" ? `${created.bundle.slug}.bundle.json` : `${created.bundle.slug}.skill.md`, text, format === "json" ? "application/json" : "text/markdown");
        }
      } catch {
        setError("Export failed");
      } finally {
        setBusy(null);
      }
    },
    [created],
  );

  if (!selected.length) return null;

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
        <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur">
          {/* count + selected chips */}
          <div className="mb-2 flex items-start gap-2">
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <Package className="h-3.5 w-3.5" />
              {selected.length} selected
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {selected.slice(0, 6).map((s) => (
                <span
                  key={s.id}
                  className="inline-flex max-w-[12rem] items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  <span className="truncate">{s.name}</span>
                  <button
                    onClick={() => onRemove(s.id)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${s.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {selected.length > 6 && (
                <span className="px-1 py-0.5 text-[11px] text-muted-foreground">+{selected.length - 6} more</span>
              )}
            </div>
            <button
              onClick={onClear}
              className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          </div>

          {/* AI prompt + generate */}
          <div className="flex items-end gap-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="Describe what you want these to do → get a runnable bundle you can Run, tweak in the builder, or export."
              className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <Button size="sm" onClick={generate} disabled={busy === "generate"} className="shrink-0">
              {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate bundle
            </Button>
          </div>

          {/* raw bundle actions (§12.5 — open to all, unchanged) */}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onCopy} disabled={busy === "copy"}>
              {busy === "copy" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : copied ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? "Copied" : "Copy bundle"}
            </Button>
            <Button size="sm" variant="outline" onClick={onDownload} disabled={busy === "download"}>
              {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download JSON
            </Button>
            {error && <span className="truncate text-[11px] text-destructive">{error}</span>}
          </div>
        </div>
      </div>

      {/* ask-first: the goal was too vague to draft a good bundle */}
      <Dialog open={!!clarify} onOpenChange={(o) => !o && setClarify(null)}>
        <DialogContent className="max-w-lg gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-primary" />
              A bit more detail?
            </DialogTitle>
            <DialogDescription>{clarify}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button size="sm" onClick={() => setClarify(null)}>
              Got it — I&apos;ll refine
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* success: a runnable bundle was saved to the library (§12.1/§12.2) */}
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="max-w-lg gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Bundle created
            </DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{created?.bundle.name}</span> — saved to your library as{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/{created?.bundle.slug}</code>. Run it, open it in the builder to tweak, or export it.
            </DialogDescription>
          </DialogHeader>
          {created?.reply && (
            <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {created.reply}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-start">
            <Button size="sm" onClick={runCreated} disabled={busy === "run"}>
              {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run
            </Button>
            <Button size="sm" variant="outline" onClick={() => created && router.push(`/bundles/${created.bundle.id}/edit`)}>
              <PenLine className="h-4 w-4" /> Open in builder
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={busy === "export"}>
                  {exportCopied ? <Check className="h-4 w-4 text-emerald-500" /> : <Download className="h-4 w-4" />} Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => exportCreated("skill")}>
                  <FileText className="size-3.5" /> Download SKILL.md
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportCreated("json")}>
                  <FileJson className="size-3.5" /> Download bundle .json
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportCreated("copy")}>
                  <Copy className="size-3.5" /> Copy markdown
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SignInDialog {...gate.dialogProps} />
    </>
  );
}
