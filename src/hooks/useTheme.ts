"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { AccentColor, Theme } from "@/lib/types";

const THEME_KEY = "studiopro-theme";
const ACCENT_KEY = "studiopro-accent";

export const ACCENT_OPTIONS: { id: AccentColor; label: string; bg: string; dot: string }[] = [
  { id: "purple", label: "Purple (Studio)", bg: "#6c63ff", dot: "#8a5cff" },
  { id: "cyan", label: "Cyan (Cyber)", bg: "#0284c7", dot: "#00d4ff" },
  { id: "green", label: "Green (Analog)", bg: "#10b981", dot: "#34d399" },
  { id: "orange", label: "Amber (Vintage)", bg: "#f59e0b", dot: "#fbbf24" },
  { id: "pink", label: "Pink (Neon)", bg: "#ec4899", dot: "#f472b6" },
];

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function readAccent(): AccentColor {
  if (typeof document === "undefined") return "purple";
  const acc = document.documentElement.getAttribute("data-accent");
  if (acc === "cyan" || acc === "green" || acc === "orange" || acc === "pink") {
    return acc;
  }
  return "purple";
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent"],
  });
  return () => observer.disconnect();
}

const getServerThemeSnapshot = (): Theme => "dark";
const getServerAccentSnapshot = (): AccentColor => "purple";

export function useTheme(): {
  theme: Theme;
  toggleTheme: () => void;
  accent: AccentColor;
  setAccent: (accent: AccentColor) => void;
} {
  const theme = useSyncExternalStore(subscribe, readTheme, getServerThemeSnapshot);
  const accent = useSyncExternalStore(subscribe, readAccent, getServerAccentSnapshot);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode */
    }
  }, []);

  const setAccent = useCallback((nextAccent: AccentColor) => {
    document.documentElement.setAttribute("data-accent", nextAccent);
    try {
      localStorage.setItem(ACCENT_KEY, nextAccent);
    } catch {
      /* private mode */
    }
  }, []);

  return { theme, toggleTheme, accent, setAccent };
}
