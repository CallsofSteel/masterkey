"use client";

// Masterkey theme store — dependency-free dark mode.
//
// The actual `.dark` class is applied to <html> by a tiny blocking inline script in
// `src/app/layout.tsx` BEFORE first paint (no flash-of-wrong-theme). This provider only
// keeps React state in sync with that, persists the user's preference, and reacts to OS
// changes when the preference is "system". The token palette for both themes already lives
// in `globals.css` (`:root` + `.dark`), so flipping the class is all that's needed.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "mk-theme";

interface ThemeContextValue {
  theme: Theme; // the user's preference
  resolvedTheme: ResolvedTheme; // what is actually applied right now
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Read the stored preference (client only). The preference doesn't drive any markup in
// the initial paint (only the dropdown's checkmark, which is portaled + closed at first
// render), so lazy-initializing from storage here is hydration-safe.
function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const s = localStorage.getItem(THEME_STORAGE_KEY);
    if (s === "light" || s === "dark" || s === "system") return s;
  } catch {
    /* localStorage unavailable (private mode) */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function applyResolved(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // Hint native UI (form controls, scrollbars) to match.
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  // Start at a deterministic "light" so SSR and the first client render agree (no
  // hydration mismatch on the toggle icon); the effect below reconciles to the real
  // value right after hydration. The page itself never flashes — the inline script in
  // layout.tsx already set the correct class on <html> before paint.
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // Resolve + apply whenever the preference changes; track the OS when "system".
  useEffect(() => {
    const update = () => {
      const r: ResolvedTheme =
        theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
      setResolvedTheme(r);
      applyResolved(r);
    };

    update();

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* ignore persistence failures */
    }
    setThemeState(t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
