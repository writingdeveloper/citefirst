import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "citefirst — RAG over the PostgreSQL 17 documentation",
  description: "Answers grounded in retrieved excerpts, with citations verified server-side.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
