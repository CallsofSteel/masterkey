"use client";

// Easter egg — the ASCII smiley in the sidebar footer replays the logo intro
// (Coinbase "C" turning into the Masterkey keyhole) on demand.
//
// Calls the player directly and deliberately does NOT touch
// localStorage["mk-intro-seen"], so replaying here never re-arms the automatic
// first-visit intro. The hook is defined by the inline script in
// src/lib/logo-intro.ts, which runs on every page.

import { cn } from "@/lib/utils";

declare global {
  interface Window {
    __mkIntroPlay?: () => { close: () => void; destroy: () => void };
  }
}

export function IntroReplayEgg({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.__mkIntroPlay?.()}
      aria-label="Replay the intro animation"
      title="Replay the intro"
      className={cn(
        "shrink-0 cursor-pointer select-none rounded-md px-1.5 py-1 font-mono text-sm leading-none",
        "text-muted-foreground/50 outline-none transition-colors",
        "hover:text-foreground font-bold hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/70",
        className,
      )}
    >
      {"☺"}
    </button>
  );
}
