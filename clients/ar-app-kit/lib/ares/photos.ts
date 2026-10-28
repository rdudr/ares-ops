// Photos go to the AR server, not the phone. A captured photo is kept on the phone only until the
// server confirms it has it (so nothing is lost without signal), then the phone's copy is deleted.
//
// The record keeps a reference, "ares-photo:<id>", in its photo field. ARES links the file to that
// record (app, record kind, field, equipment tag) whichever arrives first, and keeps with it who took
// it, when, on which app screen, and where (GPS, when the phone allows location).
import { del, get, set } from "idb-keyval";
import { AresError, ARES_API, uploadFile } from "@/lib/ares/api";
import { useAresSession } from "@/lib/ares/session";
import { APP } from "@/lib/ares/app-config";

export const PHOTO_PREFIX = "ares-photo:";
const QUEUE = `ar-photo-queue-${APP.code}`;
const bytesKey = (id: string) => `ar-photo:${id}`;
const MAX_SIDE = 2048; // enough to read a nameplate; keeps uploads small on site connections

export type PendingPhoto = {
  id: string;
  auditId: string;
  userId: string | null;
  takenAt: number;
  name: string;
  caption: string;
  screen: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  problem?: string; // why the server refused it, shown to the person
};

export const photoId = (ref?: string | null) =>
  ref && ref.startsWith(PHOTO_PREFIX) ? ref.slice(PHOTO_PREFIX.length) : null;

// --- queue (small list in IndexedDB; the bytes are stored per photo) --------------------------
const listeners = new Set<() => void>();
let cache: PendingPhoto[] = [];
const notify = () => listeners.forEach((l) => l());

async function readQueue(): Promise<PendingPhoto[]> {
  cache = ((await get(QUEUE)) as PendingPhoto[] | undefined) ?? [];
  return cache;
}
async function writeQueue(q: PendingPhoto[]) {
  cache = q;
  await set(QUEUE, q);
  notify();
}

/** Subscribe to the number of photos still waiting to reach the server. */
export function subscribePhotos(fn: () => void) {
  listeners.add(fn);
  if (typeof window !== "undefined") void readQueue().then(notify);
  return () => { listeners.delete(fn); };
}
export const pendingPhotos = () => cache;

// --- capture ------------------------------------------------------------------------------------
function position(): Promise<GeolocationPosition | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (p: GeolocationPosition | null) => resolve(p);
    navigator.geolocation.getCurrentPosition(done, () => done(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}

async function shrink(dataUrl: string): Promise<Blob> {
  const original = await (await fetch(dataUrl)).blob();
  try {
    const img = await createImageBitmap(original);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return jpeg && jpeg.size < original.size ? jpeg : original;
  } catch {
    return original; // a format the browser cannot redraw: send it as it is
  }
}

/**
 * Keeps a captured photo until it reaches the server and returns the reference to store in the
 * record's photo field. `name` describes it ("apfc_panel3_2810"); it becomes the caption.
 */
export async function queuePhoto(dataUrl: string, name: string): Promise<string> {
  const s = useAresSession.getState();
  if (!s.auditId) throw new Error("Choose the audit first.");
  const [blob, pos] = await Promise.all([shrink(dataUrl), position()]);
  const id = crypto.randomUUID();
  const clean = name.replace(/\.(jpe?g|png|heic|webp)$/i, "");
  const photo: PendingPhoto = {
    id,
    auditId: s.auditId,
    userId: s.userId,
    takenAt: Date.now(),
    name: `${clean}.jpg`,
    caption: `${APP.name} photo: ${clean.replace(/[_-]+/g, " ")}`,
    screen: typeof location !== "undefined" ? location.pathname : "",
    ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } : {}),
  };
  await set(bytesKey(id), blob);
  await writeQueue([...(await readQueue()), photo]);
  void uploadPendingPhotos();
  return `${PHOTO_PREFIX}${id}`;
}

// --- upload -------------------------------------------------------------------------------------
let running = false;

/** Sends waiting photos; called after every sync and when a photo is taken. Safe to call any time. */
export async function uploadPendingPhotos(): Promise<void> {
  if (running || typeof navigator === "undefined" || !navigator.onLine) return;
  const s = useAresSession.getState();
  if (!s.token || s.mustChangePw) return;
  running = true;
  try {
    for (const p of await readQueue()) {
      if (p.userId && p.userId !== s.userId) continue; // another person's photo: they send it
      const blob = (await get(bytesKey(p.id))) as Blob | undefined;
      if (!blob) { await writeQueue(cache.filter((x) => x.id !== p.id)); continue; }
      try {
        await uploadFile(s.token, blob, {
          id: p.id, audit_id: p.auditId, kind: "photo", caption: p.caption, taken_at: p.takenAt, name: p.name,
          lat: p.lat, lng: p.lng, accuracy_m: p.accuracy, captured_in: `${APP.name} ${p.screen}`.trim(),
        });
        // On the server now: the phone's copy goes.
        await del(bytesKey(p.id));
        await writeQueue(cache.filter((x) => x.id !== p.id));
      } catch (e) {
        if (e instanceof AresError && (e.offline || e.signedOut || e.blocked)) break; // try again later
        const msg = e instanceof Error ? e.message : String(e);
        await writeQueue(cache.map((x) => (x.id === p.id ? { ...x, problem: msg } : x)));
      }
    }
  } finally {
    running = false;
  }
}

// --- showing a photo ----------------------------------------------------------------------------
/** The photo as an image the app can show: from the phone while it waits, else from the server. */
export async function photoBlob(id: string): Promise<{ blob: Blob; where: "phone" | "server" } | null> {
  const local = (await get(bytesKey(id))) as Blob | undefined;
  if (local) return { blob: local, where: "phone" };
  const token = useAresSession.getState().token;
  if (!token) return null;
  try {
    const r = await fetch(`${ARES_API}/api/files/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? { blob: await r.blob(), where: "server" } : null;
  } catch {
    return null;
  }
}
