import type { Metadata, Viewport } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/providers/app-providers";
import { StorageNotice, UpdateBanner } from "@/components/ares/app-chrome";
import { APP } from "@/lib/ares/app-config";

// The AR Enterprise website's type: DM Sans for text, Fraunces for headings. Bundled at build time,
// so the Android app shows them offline too.
const sans = DM_Sans({ variable: "--font-ar-sans", subsets: ["latin"], display: "swap" });
const display = Fraunces({ variable: "--font-ar-display", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: `${APP.name} — AR Enterprise`,
  description: APP.tagline,
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
          {children}
          <StorageNotice />
        </AppProviders>
      </body>
    </html>
  );
}
