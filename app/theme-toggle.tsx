"use client";

import { useEffect, useState } from "react";

/**
 * Three states rather than two, because "follow the system" is a real choice
 * and a plain light/dark switch throws it away the moment anyone touches it.
 */
type Mode = "system" | "light" | "dark";

const ORDER: Mode[] = ["system", "light", "dark"];
const KEY = "preflight-theme";

const LABEL: Record<Mode, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

function apply(mode: Mode) {
  const root = document.documentElement;
  try {
    if (mode === "system") {
      localStorage.removeItem(KEY);
      root.removeAttribute("data-theme");
    } else {
      localStorage.setItem(KEY, mode);
      root.setAttribute("data-theme", mode);
    }
  } catch {
    // A browser refusing storage should still switch the theme for this visit.
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }
}

export default function ThemeToggle() {
  // Start at "system" so server and client markup agree; the inline script in
  // the layout has already applied any saved choice to the document.
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") setMode(saved);
    } catch {}
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    setMode(next);
    apply(next);
  }

  return (
    <button
      onClick={cycle}
      title={`Theme: ${LABEL[mode]}. Click to cycle auto → light → dark.`}
      aria-label={`Theme: ${LABEL[mode]}. Click to change.`}
      className="flex items-center gap-1.5 rounded border border-line bg-panel px-2.5 py-1.5 text-xs text-muted transition hover:border-faint hover:text-ink"
    >
      <Glyph mode={mode} />
      <span className="font-mono">{LABEL[mode]}</span>
    </button>
  );
}

function Glyph({ mode }: { mode: Mode }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (mode === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }

  if (mode === "dark") {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }

  // Auto: half-filled circle, the usual shorthand for "whatever the OS says".
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
