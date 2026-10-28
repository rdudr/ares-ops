"use client";
// Shows the photo stored in a record field: a thumbnail and where it is (waiting on this phone, or
// saved on the AR server). Tap the thumbnail to see it full size.
import { useEffect, useState, useSyncExternalStore } from "react";
import { CloudUpload, ImageOff, Loader2, Server } from "lucide-react";
import { pendingPhotos, photoBlob, photoId, subscribePhotos } from "@/lib/ares/photos";

export function usePendingPhotoCount() {
  return useSyncExternalStore(subscribePhotos, () => pendingPhotos().length, () => 0);
}

export function PhotoRef({ value, label = "Photo" }: { value?: string | null; label?: string }) {
  const id = photoId(value);
  const waiting = useSyncExternalStore(subscribePhotos, () => (id ? pendingPhotos().find((p) => p.id === id) ?? null : null), () => null);
  const [src, setSrc] = useState<string | null>(null);
  const [where, setWhere] = useState<"phone" | "server" | "missing" | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true, url: string | null = null;
    photoBlob(id).then((r) => {
      if (!live) return;
      if (!r) { setWhere("missing"); return; }
      url = URL.createObjectURL(r.blob);
      setSrc(url);
      setWhere(r.where);
    });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id, !!waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!value) return <span className="text-xs text-slate-600">No photo</span>;
  if (!id) {
    // Taken before photos went to the server: the file is still only on that phone.
    return <span className="break-all text-xs text-slate-600">Older photo kept on this phone: {value}</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      {src ? (
        <button type="button" onClick={() => window.open(src, "_blank")} className="shrink-0 overflow-hidden rounded-md border border-slate-200" aria-label={`Open ${label.toLowerCase()} full size`}>
          <img src={src} alt={label} className="h-12 w-16 object-cover" />
        </button>
      ) : where === "missing" ? (
        <ImageOff className="size-5 text-slate-600" aria-hidden />
      ) : (
        <Loader2 className="size-4 animate-spin text-slate-600" aria-hidden />
      )}
      <span className="text-xs">
        {waiting ? (
          <span className="inline-flex items-center gap-1 text-amber-800">
            <CloudUpload className="size-3.5" aria-hidden />
            {waiting.problem ? `Not uploaded: ${waiting.problem}` : "Waiting to upload, kept on this phone until it reaches the server"}
          </span>
        ) : where === "missing" ? (
          <span className="text-slate-600">Saved on the AR server (shown when online)</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-800"><Server className="size-3.5" aria-hidden /> Saved on the AR server</span>
        )}
      </span>
    </span>
  );
}
