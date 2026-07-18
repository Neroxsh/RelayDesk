import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "RelayDesk — Codex 与 Claude Code 远程工作台";
  const description = "从手机继续电脑上的 Codex 与 Claude Code 会话。";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    manifest: "/manifest.webmanifest",
    applicationName: "RelayDesk",
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "RelayDesk" },
    formatDetection: { telephone: false },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg", apple: "/favicon.svg" },
    openGraph: {
      type: "website",
      url: origin,
      title,
      description,
      images: [{ url: `${origin}/og-v4.png`, width: 1536, height: 1024, alt: "RelayDesk" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og-v4.png`] },
  };
}

export const viewport: Viewport = {
  themeColor: "#0c1017",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
