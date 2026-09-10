import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preflight — a simulation gate for agent writes",
  description:
    "Before an agent changes a real system, Preflight performs the write inside a transaction that rolls back, proves what would happen, checks it against policy, and shows the rollback path.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
