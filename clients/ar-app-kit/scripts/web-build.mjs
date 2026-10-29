// Builds this AR app as a web app (PWA) served from the AR server under a sub-path.
//
//   node scripts/web-build.mjs --base /field/brief
//
// The same screens as the Android app, signed in with the same ARES login, so the team can work
// from a laptop or install it from the browser. Output in out/: the static site, a web app
// manifest (so browsers offer "Install") and a service worker that keeps the app's screens on
// the device, so it opens without internet. Data is saved on the device and synced, as on the phone.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const root = process.cwd();
const args = process.argv.slice(2);
// Given as "field/brief" (Git Bash on Windows rewrites "/field/brief" into a folder path).
const base = "/" + (args[args.indexOf("--base") + 1] || "").replace(/^\/+|\/+$/g, "");
if (!/^\/[a-z0-9/-]+$/.test(base)) throw new Error("Give the sub-path, e.g. --base field/brief");

const cfg = fs.readFileSync(path.join(root, "lib/ares/app-config.ts"), "utf8");
const field = (k) => { const m = cfg.match(new RegExp(`${k}:\\s*("(?:[^"\\\\]|\\\\.)*")`)); return m ? JSON.parse(m[1]) : ""; };
const APP = { code: field("code"), name: field("name"), tagline: field("tagline") };

// Leftover dev-server type files (.next/dev) can be half-written and break the type check.
fs.rmSync(path.join(root, ".next", "dev"), { recursive: true, force: true });
execSync("npm run build:mobile", { stdio: "inherit", cwd: root, env: { ...process.env, NEXT_PUBLIC_BASE_PATH: base } });

const out = path.join(root, "out");
fs.writeFileSync(path.join(out, "manifest.webmanifest"), JSON.stringify({
  name: `${APP.name} — AR Enterprise`,
  short_name: APP.name,
  description: APP.tagline,
  id: `${base}/`,
  start_url: `${base}/`,
  scope: `${base}/`,
  display: "standalone",
  background_color: "#fbf9f4",
  theme_color: "#fbf9f4",
  icons: [
    { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
  ],
}, null, 2));

// Everything the app needs to open offline (pages, scripts, styles, fonts, images), except large files.
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (fs.statSync(p).size < 3e6 && !/\.(map|txt)$/.test(e.name) && e.name !== "sw.js") {
      files.push(`${base}/${path.relative(out, p).replace(/\\/g, "/")}`.replace(/\/index\.html$/, "/"));
    }
  }
};
walk(out);
const version = crypto.createHash("sha256").update(files.join("\n") + fs.readFileSync(path.join(out, "index.html"))).digest("hex").slice(0, 12);

fs.writeFileSync(path.join(out, "sw.js"), `// ${APP.name} web app: keeps the app's screens on this device so it opens without internet.
// Data is not cached here: the app saves it on the device and syncs it with ARES itself.
const CACHE = "ar-${APP.code}-${version}";
const BASE = "${base}";
const FILES = ${JSON.stringify(files)};

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ar-${APP.code}-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(BASE + "/")) return;
  if (e.request.mode === "navigate") {
    // Pages: the newest from the server when online, the kept copy when not.
    const page = url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
    e.respondWith(fetch(e.request).catch(() =>
      caches.match(page).then((r) => r || caches.match(BASE + "/"))));
    return;
  }
  // Scripts, styles, fonts, images: the kept copy first (they never change under the same name).
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
`);
console.log(`Web app ready in out/ for ${base}/ (${files.length} files kept for offline, version ${version})`);
