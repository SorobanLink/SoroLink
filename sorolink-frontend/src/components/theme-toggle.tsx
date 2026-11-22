"use client";

import { useEffect, useState } from "react";
import { THEME_STORAGE_KEY, getInitialTheme, type Theme } from "@/lib/theme";

// #5 — Light / dark theme toggle. On first load the theme follows the OS
// `prefers-color-scheme`; a manual choice is persisted in localStorage.

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const initial = getInitialTheme();
    applyTheme(initial);
    setTheme(initial);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label="Dark mode"
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span aria-hidden="true">{isDark ? "☾" : "☀"}</span>
      <span className="theme-toggle__label">{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
