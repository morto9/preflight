import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preflight — a simulation gate for agent writes",
  description:
    "Before an agent changes a real system, Preflight performs the write inside a transaction that rolls back, proves what would happen, checks it against policy, and shows the rollback path.",
};

/**
 * Applies a saved theme before the first paint.
 *
 * Without this the page renders at the system preference and then snaps to the
 * saved one once React hydrates, which on a dark-to-light switch is a full
 * white flash.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem("preflight-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
