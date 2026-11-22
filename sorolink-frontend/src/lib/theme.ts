// #5 — Shared theme constants (importable from server and client components).

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "sorolink:theme";

/**
 * Inline script run in <head> before first paint so the stored theme, or the
 * OS `prefers-color-scheme` on first load, is applied without a flash.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){}})();`;

export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore storage errors
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}
