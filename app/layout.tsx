import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "阅读 · Reader",
  description: "一个移动端友好的 HTML 阅读器",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Reader",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#141414" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
