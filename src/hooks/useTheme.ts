"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Theme } from "@/lib/types";

const KEY = "studiopro-theme";

/**
 * Theme lives on <html data-theme> (set pre-paint by the boot script in
 * layout.tsx). We mirror it into React with useSyncExternalStore — the
 * canonical pattern for external sources of truth — and persist user
 * choices to localStorage.
 */
function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

const getServerSnapshot = (): Theme => "dark";

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, readTheme, getServerSnapshot);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode — theme simply won't persist */
    }
  }, []);

  return { theme, toggleTheme };
}
