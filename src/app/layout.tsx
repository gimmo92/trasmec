import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trasmec — Generatore Offerte AI",
  description: "Creazione automatica di offerte da distinte base con Claude",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
