"use client";

// Masterkey logo doubling as the light/dark toggle (lives in the sidebar footer).
// Click → flips the theme, spins the logo one full turn, and in dark mode the brand
// blue drops to a monochrome (inverted) treatment. See `src/lib/theme.tsx`.

import { useState } from "react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function LogoThemeToggle({
  className,
  size = 24,
  label,
}: {
  className?: string;
  size?: number;
  label?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [turns, setTurns] = useState(0);
  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(isDark ? "light" : "dark");
        setTurns((t) => t + 1); // each press = one more full clockwise rotation
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      title={isDark ? "Light mode" : "Dark mode"}
      className={cn(
        "flex items-center gap-2 rounded-md outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring/70 cursor-pointer",
        className,
      )}
    >
      <svg
        viewBox="0 0 726.15 726.15"
        width={size}
        height={size}
        role="img"
        aria-hidden="true"
        className="h-6 w-6 shrink-0 rounded-md"
        style={{
          transform: `rotate(${turns * 360}deg)`,
          transition: "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {/* Rounded square — brand blue in light, monochrome (sidebar foreground) in dark */}
        <rect
          width="726.15"
          height="726.15"
          rx="107.9"
          ry="107.9"
          className="fill-[#1733ff] transition-colors duration-300 dark:fill-sidebar-foreground"
        />
        {/* The "S" mark — white in light, sidebar background in dark (inverted mono) */}
        <g className="fill-white transition-colors duration-300 dark:fill-sidebar">
          <path d="M349.82,294.72c22.17-4.15,43.77,2.05,60,16.69,15.6,14.07,24.31,34.97,22.71,56.61-2.18,23.72-15.72,44.38-36.56,55.81l26.79,104.98c36.7-12.54,67.58-37.3,88.43-68.76,55.4-83.56,30.32-195.45-55.04-247.61-35.21-21.51-77.77-30.08-118.82-24.16-91.84,13.23-157.8,94.18-151.4,187.02,4.74,68.75,51,130.73,117.35,153.48l26.76-105.02c-20.05-11.12-33.73-30.73-36.23-53.79-3.85-35.42,20.7-68.63,56.03-75.24Z" />
          <path d="M349.82,294.72c-35.33,6.61-59.88,39.82-56.03,75.24,2.51,23.06,16.18,42.67,36.23,53.79l-26.76,105.02c-66.35-22.75-112.61-84.73-117.35-153.48-6.4-92.84,59.56-173.79,151.4-187.02,41.05-5.91,83.61,2.65,118.82,24.16,85.37,52.16,110.44,164.05,55.04,247.61-20.85,31.45-51.73,56.21-88.43,68.76l-26.79-104.98c20.84-11.43,34.39-32.09,36.56-55.81,1.61-21.64-7.11-42.54-22.71-56.61-16.23-14.63-37.83-20.83-60-16.69Z" />
        </g>
      </svg>
      {label && (
        <span className="font-heading text-lg italic leading-none text-foreground">
          {label}
        </span>
      )}
    </button>
  );
}
