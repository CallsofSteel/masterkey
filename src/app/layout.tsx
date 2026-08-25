import type { Metadata } from "next";
import { Inter, Instrument_Serif, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LOGO_INTRO_SCRIPT } from "@/lib/logo-intro";
import { Providers } from "./providers";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-heading",
  weight: "400",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://www.masterkey.sh";

// Applies the saved (or system) theme to <html> BEFORE first paint, so there is no
// flash-of-wrong-theme. Kept in sync afterwards by ThemeProvider (src/lib/theme.tsx).
const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('mk-theme');var d=s==='dark'||((s===null||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: "Masterkey — Every API a Developer Needs",
  description:
    "Browse 500+ APIs and services across 19 categories. Find the best tools for media, infrastructure, AI, payments, and more.",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Masterkey — Every API a Developer Needs",
    description:
      "Browse 500+ APIs and services across 19 categories. Find the best tools for media, infrastructure, AI, payments, and more.",
    url: BASE_URL,
    siteName: "Masterkey",
    images: [{ url: `${BASE_URL}/og.png`, width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Masterkey — Every API a Developer Needs",
    description:
      "Browse 500+ APIs and services across 19 categories. Find the best tools for media, infrastructure, AI, payments, and more.",
    images: [`${BASE_URL}/og.png`],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-svh">
        {/* Sets the theme class on <html> before paint (no flash). Static, trusted string. */}
        <script>{THEME_INIT_SCRIPT}</script>
        {/* One-time C-to-keyhole logo intro. Self-gating: homepage + first visit +
            no reduced-motion, else it no-ops. See src/lib/logo-intro.ts. */}
        <script>{LOGO_INTRO_SCRIPT}</script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
