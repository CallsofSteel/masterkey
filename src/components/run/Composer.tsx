"use client";

// Masterkey — goal composer (W2). Two entry modes: standalone "describe your goal" (no seed) and
// seeded from a catalog service (seedServiceId). Flow: gate on sign-in (W1 — draft + uploads survive
// the dialog), upload attachments to Blob (W3), POST /api/runs, navigate to /run/[runId]. Concurrent
// runs per user are allowed. Type "@" to search + pin specific services (§3.2): selecting one inserts
// its serviceId inline, and the seed prompt resolves @<serviceId> to a "prefer these" instruction.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, X, Loader2, ArrowUp, FileText, AtSign, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSignInGate } from "@/components/auth/sign-in-gate";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { ServiceMention } from "@/components/run/ServiceMention";
import { BundleMention } from "@/components/run/BundleMention";
import { useCatalogEntries } from "@/lib/catalog-entries";
import { useBundles, type BundleSummary } from "@/lib/bundle-list";
import type { EntrySummary } from "@/data/types";

const MENTION_LIMIT = 8;

interface UploadedAsset {
  url: string;
  mime: string;
  bytes: number;
  name: string;
}

export function Composer({
  seedServiceId,
  seedServiceName,
  seedBackendProviderId,
  parentRunId,
  placeholder,
  autoFocus,
  onSubmitted,
  menuPlacement = "up",
}: {
  seedServiceId?: string;
  seedServiceName?: string;
  seedBackendProviderId?: string;
  parentRunId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** When set (continuous-thread reply), stay on the page: the new run is appended via this callback
   *  instead of navigating to /run/[newId]. */
  onSubmitted?: (newRunId: string) => void;
  /** "@"/"/" autocomplete direction. Default "up" (chat session, composer near the bottom). The home-page
   *  composer sits high on the page, so it passes "down" — opening up would clip off the top of the screen. */
  menuPlacement?: "up" | "down";
}) {
  const router = useRouter();
  const gate = useSignInGate();
  const [goal, setGoal] = useState("");
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pendingSubmit = useRef(false);

  // Autocomplete state. Only ONE menu is open at a time: "@" services (§3.2) or "/" bundles (slash
  // recipes). `menuStart` is the index of the active "@"/"/" in `goal`; menu=null = closed. menuIndex is
  // the shared highlighted row.
  const entries = useCatalogEntries();
  const bundles = useBundles();
  const [menu, setMenu] = useState<"service" | "bundle" | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [menuStart, setMenuStart] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);

  const serviceResults = useMemo<EntrySummary[]>(() => {
    if (menu !== "service") return [];
    const q = menuQuery.toLowerCase();
    return entries
      .map((e) => {
        const name = e.name.toLowerCase();
        const hay = `${name} ${(e.provider ?? "").toLowerCase()} ${(e.category ?? "").toLowerCase()} ${e.id} ${(e.tags ?? []).join(" ").toLowerCase()}`;
        let score = -1;
        if (!q) score = 0;
        else if (name.startsWith(q)) score = 3;
        else if (name.includes(q)) score = 2;
        else if (hay.includes(q)) score = 1;
        return { e, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
      .slice(0, MENTION_LIMIT)
      .map((x) => x.e);
  }, [menu, menuQuery, entries]);

  const bundleResults = useMemo<BundleSummary[]>(() => {
    if (menu !== "bundle") return [];
    const q = menuQuery.toLowerCase();
    return bundles
      .filter((b) => !q || `${b.name} ${b.slug} ${b.description} ${b.trigger ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) // favorites pinned to top (§6.4)
      .slice(0, MENTION_LIMIT);
  }, [menu, menuQuery, bundles]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setMenuStart(-1);
  }, []);

  // Detect an active autocomplete token the cursor is inside:
  //  • "@<word>" — "@" at start or after whitespace (so emails like x@gmail don't trigger) → service menu
  //  • "/<word>" — "/" only at the very start of the input → bundle (slash-command) menu
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setGoal(val);
      const pos = e.target.selectionStart ?? val.length;
      const before = val.slice(0, pos);
      const at = before.lastIndexOf("@");
      if (at !== -1 && (at === 0 || /\s/.test(before[at - 1])) && /^[a-zA-Z0-9-]*$/.test(before.slice(at + 1))) {
        setMenu("service");
        setMenuQuery(before.slice(at + 1));
        setMenuStart(at);
        setMenuIndex(0);
        return;
      }
      const cmd = before.match(/^\/([a-z0-9-]*)$/i); // slash-command: "/" must be the first character
      if (cmd) {
        setMenu("bundle");
        setMenuQuery(cmd[1]);
        setMenuStart(0);
        setMenuIndex(0);
        return;
      }
      closeMenu();
    },
    [closeMenu],
  );

  // Replace the active "@…"/"/…" token with the chosen token + a trailing space, and reposition the caret.
  const insertToken = useCallback(
    (token: string) => {
      const ta = textRef.current;
      const pos = ta?.selectionStart ?? goal.length;
      const head = goal.slice(0, menuStart);
      const tail = goal.slice(pos);
      const next = `${head}${token} ${tail}`;
      setGoal(next);
      closeMenu();
      setTimeout(() => {
        if (ta) {
          const caret = head.length + token.length + 1;
          ta.focus();
          ta.setSelectionRange(caret, caret);
        }
      }, 0);
    },
    [goal, menuStart, closeMenu],
  );
  const selectService = useCallback((e: EntrySummary) => insertToken(`@${e.id}`), [insertToken]);
  const selectBundle = useCallback((b: BundleSummary) => insertToken(`/${b.slug}`), [insertToken]);

  const menuOpen = menu !== null;
  const menuCount = menu === "service" ? serviceResults.length : menu === "bundle" ? bundleResults.length : 0;
  const acceptMenu = useCallback(() => {
    if (menu === "service" && serviceResults[menuIndex]) selectService(serviceResults[menuIndex]);
    else if (menu === "bundle" && bundleResults[menuIndex]) selectBundle(bundleResults[menuIndex]);
  }, [menu, serviceResults, bundleResults, menuIndex, selectService, selectBundle]);

  const ph =
    placeholder ??
    (seedServiceName
      ? `Describe what you want ${seedServiceName} to do…`
      : "Describe your goal — e.g. “find nearby offices and prepare catering outreach”");

  async function uploadFiles(files: FileList) {
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        if (seedServiceId) fd.append("serviceId", seedServiceId);
        const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          setError(e.error ?? `couldn't upload ${file.name}`);
          continue;
        }
        const a = (await res.json()) as { url: string; mime: string; bytes: number };
        setAssets((prev) => [...prev, { url: a.url, mime: a.mime, bytes: a.bytes, name: file.name }]);
      }
    } catch {
      setError("Upload failed — try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const doSubmit = useCallback(async () => {
    const g = goal.trim();
    if (!g) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: g,
          seedServiceId,
          seedBackendProviderId,
          parentRunId,
          assetUrls: assets.map((a) => a.url),
        }),
      });
      if (res.status === 401) {
        gate.openSignIn();
        return;
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setError(e.error ?? "couldn't start the run");
        return;
      }
      const { runId } = (await res.json()) as { runId: string };
      if (onSubmitted) {
        // Continuous-thread reply: clear the composer and let the session view poll in the new run.
        setGoal("");
        setAssets([]);
        onSubmitted(runId);
      } else {
        router.push(`/run/${runId}`);
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setSubmitting(false);
    }
  }, [goal, assets, seedServiceId, seedBackendProviderId, parentRunId, router, gate, onSubmitted]);

  function onRun() {
    setError(null);
    if (!gate.ensureSignedIn()) {
      pendingSubmit.current = true; // proceed automatically once signed in (draft preserved)
      return;
    }
    void doSubmit();
  }

  // After sign-in completes, auto-proceed if the user pressed Run while signed out.
  useEffect(() => {
    if (gate.signedIn && pendingSubmit.current) {
      pendingSubmit.current = false;
      void doSubmit();
    }
  }, [gate.signedIn, doSubmit]);

  const busy = uploading || submitting;

  return (
    <div className="relative rounded-xl border border-border bg-card p-3 shadow-sm">
      {menu === "service" && (
        <ServiceMention
          results={serviceResults}
          selectedIndex={menuIndex}
          onSelect={selectService}
          onHover={setMenuIndex}
          placement={menuPlacement}
        />
      )}
      {menu === "bundle" && (
        <BundleMention
          results={bundleResults}
          selectedIndex={menuIndex}
          onSelect={selectBundle}
          onHover={setMenuIndex}
          placement={menuPlacement}
        />
      )}
      <textarea
        ref={textRef}
        value={goal}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={(e) => {
          if (menuOpen && menuCount) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMenuIndex((i) => Math.min(i + 1, menuCount - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMenuIndex((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              acceptMenu();
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenu();
              return;
            }
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onRun();
        }}
        placeholder={ph}
        rows={seedServiceName ? 2 : 3}
        className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />

      {assets.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {assets.map((a, i) => (
            <span
              key={a.url}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground"
            >
              <FileText className="size-3" />
              <span className="max-w-32 truncate">{a.name}</span>
              <button
                onClick={() => setAssets((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${a.name}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Attach files"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            Attach
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Mention a specific service"
            onClick={() => {
              const ta = textRef.current;
              if (!ta) return;
              const pos = ta.selectionStart ?? goal.length;
              const needsSpace = pos > 0 && !/\s/.test(goal[pos - 1]);
              const ins = needsSpace ? " @" : "@";
              const caret = pos + ins.length;
              setGoal(goal.slice(0, pos) + ins + goal.slice(pos));
              setMenu("service");
              setMenuQuery("");
              setMenuStart(caret - 1);
              setMenuIndex(0);
              setTimeout(() => {
                ta.focus();
                ta.setSelectionRange(caret, caret);
              }, 0);
            }}
          >
            <AtSign className="size-4" /> Service
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Run a bundle (multi-step recipe)"
            onClick={() => {
              const ta = textRef.current;
              if (!ta) return;
              // Slash-commands live at the very start; prepend "/" and open the bundle menu.
              setGoal(`/${goal}`);
              setMenu("bundle");
              setMenuQuery("");
              setMenuStart(0);
              setMenuIndex(0);
              setTimeout(() => {
                ta.focus();
                ta.setSelectionRange(1, 1);
              }, 0);
            }}
          >
            <Workflow className="size-4" /> Bundle
          </Button>
        </div>
        <Button type="button" size="sm" onClick={onRun} disabled={busy || !goal.trim()}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          Run it
        </Button>
      </div>

      <SignInDialog {...gate.dialogProps} />
    </div>
  );
}
