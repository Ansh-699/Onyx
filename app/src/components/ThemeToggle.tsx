"use client";

// Light/dark toggle. Persists to localStorage; the actual first-paint theme
// choice happens in the blocking <script> in layout.tsx (see NO_FLASH_SCRIPT
// below) so there is never a flash of the wrong theme — this component only
// needs to reflect and change the *current* state, not decide the initial one.

import { useEffect, useState } from "react";
import styles from "./ThemeToggle.module.css";

export const THEME_STORAGE_KEY = "onyx:theme";

// Inlined into <head> as a blocking script (must run before first paint).
// Kept as a plain string, not a React event handler, for that reason.
export const NO_FLASH_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
`;

function getCurrentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  // Mirrors the DOM attribute the blocking script already set — avoids a
  // hydration mismatch by reading nothing theme-related during SSR.
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    setTheme(getCurrentTheme());
  }, []);

  function toggle() {
    const next = getCurrentTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggle}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
    >
      {/* Both icons always render (no theme === null flash of an empty
          button); CSS opacity/rotate driven by [data-theme] cross-fades them. */}
      <svg className={styles.sun} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" />
        </g>
      </svg>
      <svg className={styles.moon} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
