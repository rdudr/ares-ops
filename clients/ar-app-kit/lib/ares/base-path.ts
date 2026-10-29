// Where this app is served. The Android app and local development use the root; the web copy on
// the AR server lives under /field/<app>/ (set NEXT_PUBLIC_BASE_PATH at build time). Next's own
// links and routes add it by themselves; plain image and fetch paths go through asset().
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const asset = (p: string) => `${BASE_PATH}${p}`;
