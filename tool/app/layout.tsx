import type { Metadata, Viewport } from "next";
import { Newsreader, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Fonts: Newsreader for headings, Geist for text and Geist Mono for data and code, served
// with the app by next/font.
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", display: "swap", axes: ["opsz"], style: ["normal", "italic"] });
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "LEADS",
  // Tagline used in link previews.
  description: "Forecast-informed decision support for drinking-water supply reservoirs",
};

// Viewport for phones and tablets (the same as Next's default).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} style={{ height: "100%" }}>
      <body suppressHydrationWarning style={{ height: "100%", margin: 0 }}>{children}</body>
    </html>
  );
}
