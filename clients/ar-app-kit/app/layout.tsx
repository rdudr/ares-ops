import type { Metadata, Viewport } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/providers/app-providers";
import { PwaRegister, StorageNotice, UpdateBanner } from "@/components/ares/app-chrome";
import { BASE_PATH, asset } from "@/lib/ares/base-path";
import { APP } from "@/lib/ares/app-config";

// The AR Enterprise website's type: DM Sans for text, Fraunces for headings. Bundled at build time,
// so the Android app shows them offline too.
const sans = DM_Sans({ variable: "--font-ar-sans", subsets: ["latin"], display: "swap" });
const display = Fraunces({ variable: "--font-ar-display", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: `${APP.name} — AR Enterprise`,
  description: APP.tagline,
  // The web copy (under /field/<app>/) installs as an app from the browser.
  ...(BASE_PATH ? { manifest: asset("/manifest.webmanifest"), appleWebApp: { capable: true, title: APP.name, statusBarStyle: "default" as const } } : {}),
};

export const viewport: Viewport = {
  themeColor: "#fbf9f4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} h-full`}>
      <body className="min-h-full antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <AppProviders>
          <UpdateBanner />
          <PwaRegister />
          {children}
          <StorageNotice />
        </AppProviders>
      </body>
    </html>
  );
}
