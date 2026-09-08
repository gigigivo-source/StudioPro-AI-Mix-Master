import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "StudioPro — AI Mix & Master",
  description:
    "Professional studio-grade mixing and mastering rendered entirely in your browser. Drop a stem bundle, pick a genre profile, and get a broadcast-ready master with A/B comparison and full loudness analysis.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

/* Apply the saved theme before first paint (no flash). */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("studiopro-theme");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-dvh font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
