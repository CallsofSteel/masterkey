"use client";

// Masterkey — Bundle Studio "new bundle" entry (spec §7.1/§12.3). Creates a draft bundle (seeded with a
// Purpose node) via POST /api/studio/bundles, then redirects to the canvas editor so autosave (which needs
// a bundle id) works immediately. Anonymous → bounced to the library (which gates sign-in).

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function NewBundlePage() {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const purposeId = `purpose-${Math.random().toString(36).slice(2, 9)}`;
      const res = await fetch("/api/studio/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Untitled bundle",
          nodes: [{ id: purposeId, type: "purpose", position: { x: 280, y: 140 }, data: { type: "purpose", label: "New bundle" } }],
          edges: [],
        }),
      });
      if (res.ok) {
        const b = await res.json();
        router.replace(`/bundles/${b.id}/edit`);
      } else {
        router.replace("/bundles");
      }
    })();
  }, [router]);

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <p className="text-sm">Creating bundle…</p>
    </div>
  );
}
