import type { Config } from "tailwindcss";

// Additive Tailwind layer on top of the existing hand-written CSS-variable
// design system (globals.css) — preflight is OFF so Tailwind never resets
// the base typography/element styles every existing CSS-module page relies
// on. Colors point straight at the existing --var()s (no parallel
// --background/--primary/etc. custom-property set) so there is exactly one
// source of truth per token, and no collision with the existing `--accent`
// brand-color variable used throughout the app.
const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        background: "var(--bg)",
        foreground: "var(--text)",
        primary: {
          DEFAULT: "var(--accent)",
          foreground: "#06121a",
        },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--text)",
        },
        muted: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--text-dim)",
        },
        // Tailwind's neutral "hover surface" semantic — deliberately NOT the
        // same CSS variable as the brand --accent color (see header note).
        accent: {
          DEFAULT: "var(--surface-3)",
          foreground: "var(--text)",
        },
        destructive: {
          DEFAULT: "var(--red)",
          foreground: "#1a0606",
        },
        border: "var(--border-strong)",
        input: "var(--border)",
        ring: "var(--accent-strong)",
      },
    },
  },
  plugins: [],
};

export default config;
