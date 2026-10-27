"use client";
// App-wide pieces of every AR app: the first-run storage notice and the "new version" banner.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Download, ShieldCheck, X } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Button } from "@/components/ui/button";
import { APP } from "@/lib/ares/app-config";
import { useIsClient } from "@/lib/ares/client-state";
import pkg from "@/package.json";

const NOTICE_KEY = "ar-storage-notice-v1";

// The public page where every AR app's latest APK is listed (GitHub Pages of the APK repo).
export const APK_INDEX_URL = (process.env.NEXT_PUBLIC_APK_INDEX || "https://ops.arenergyservices.in/apps/").replace(/\/$/, "");

function readFlag(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeFlag(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage blocked: the notice just shows again */ }
}

/** Explains, once, what the app keeps on the device. No cookies, no tracking. */
export function StorageNotice() {
  const isClient = useIsClient();
  const [hidden, setHidden] = useState(false);
  if (!isClient || hidden || readFlag(NOTICE_KEY)) return null;
  const ok = () => { writeFlag(NOTICE_KEY, String(Date.now())); setHidden(true); };
  return (
    <section
      role="region"
      aria-label="Privacy and storage"
      className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-4 shadow-lg shadow-slate-900/10 sm:inset-x-auto sm:right-4"
    >
      <div className="flex gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cyan-800" aria-hidden />
        <div className="min-w-0 flex-1 text-sm text-slate-700">
          <p className="font-semibold text-slate-900">Your data stays with your team</p>
          <p className="mt-1">
            {APP.name}{" "}saves your sign-in and the audit you work on in this device&apos;s storage so it works offline, and
            sends them only to the AR Energy Services server. No cookies, no advertising, no tracking.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={ok}>OK</Button>
            <Button size="sm" variant="secondary" asChild>
              <Link href="/privacy">Privacy &amp; storage</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

type IndexEntry = { version: string; apk_url: string; released_at?: string };

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
};

/**
 * In the Android app: checks the APK page once a day and, when a newer build of this app is
 * published, offers it. Android always asks the person to confirm an install, so the download
 * starts in the background and the person taps Install.
 */
export function UpdateBanner() {
  const [latest, setLatest] = useState<IndexEntry | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const last = Number(readFlag("ar-update-checked") || 0);
    if (Date.now() - last < 6 * 3600e3 && !readFlag("ar-update-pending")) return;
    fetch(`${APK_INDEX_URL}/apps.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => {
        writeFlag("ar-update-checked", String(Date.now()));
        const entry: IndexEntry | undefined = idx?.apps?.[APP.code];
        if (entry && newer(entry.version, pkg.version)) {
          writeFlag("ar-update-pending", entry.version);
          setLatest(entry);
        } else {
          try { localStorage.removeItem("ar-update-pending"); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* offline: try again next time */ });
  }, []);

  if (!latest || closed) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-3 border-b border-cyan-200 bg-cyan-50 px-4 py-2 text-sm text-cyan-900">
      <span>A new version of {APP.name} is ready: <strong>v{latest.version}</strong> (you have v{pkg.version}).</span>
      <Button size="sm" asChild>
        <a href={latest.apk_url} target="_blank" rel="noopener noreferrer"><Download aria-hidden /> Download update</a>
      </Button>
      <Button size="icon" variant="ghost" aria-label="Hide update message" onClick={() => setClosed(true)}><X aria-hidden /></Button>
    </div>
  );
}
