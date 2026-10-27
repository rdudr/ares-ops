// Ready-made AppBinding for the usual AR app store: an optional company profile plus lists of items
// that each have an `id` (compressors, pump tests, boilers, cooling towers, …). Each item becomes one
// ARES record of its list's kind; the profile becomes one record per audit.
import type { StoreApi, UseBoundStore } from "zustand";
import type { PulledRecord } from "./api";
import { useAresSession } from "./session";
import type { AppBinding, LocalRecord } from "./sync";

type Item = { id: string } & Record<string, unknown>;

export type CollectionSpec = {
  /** Key of the list in the store, e.g. "compressors". */
  key: string;
  /** ARES record kind, e.g. "compressor". */
  kind: string;
  /** Equipment tag (unique per audit and app); return null when the item has none. */
  tag?: (item: Item) => unknown;
  /** When the reading was taken (ISO string or ms); defaults to createdAt. */
  takenAt?: (item: Item) => unknown;
};

type PersistApi = { persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } };

const toTime = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || Date.now() : Date.now());
const toTag = (v: unknown) => (v == null ? null : String(v).trim() || null);

export function collectionBinding<S extends object>(
  store: UseBoundStore<StoreApi<S>> & PersistApi,
  opts: { profileKey?: string; collections: CollectionSpec[]; clear: () => void },
): AppBinding {
  const profileRecordId = () => `company-${useAresSession.getState().auditId ?? "none"}`;
  const byKind = new Map(opts.collections.map((c) => [c.kind, c]));

  return {
    snapshot() {
      const s = store.getState() as Record<string, unknown>;
      const out: LocalRecord[] = [];
      const profile = opts.profileKey ? (s[opts.profileKey] as Item | null) : null;
      if (profile) out.push({ id: profileRecordId(), kind: "company_profile", tag: null, takenAt: toTime(profile.updatedAt), payload: profile });
      for (const c of opts.collections) {
        for (const item of (s[c.key] as Item[] | undefined) ?? []) {
          out.push({
            id: String(item.id),
            kind: c.kind,
            tag: toTag(c.tag ? c.tag(item) : null),
            takenAt: toTime(c.takenAt ? c.takenAt(item) : item.createdAt),
            payload: item,
          });
        }
      }
      return out;
    },

    subscribe: (listener) => store.subscribe(listener),

    apply(upserts: PulledRecord[], deletedIds: string[]) {
      const gone = new Set(deletedIds);
      store.setState((prev) => {
        const s = prev as Record<string, unknown>;
        const next: Record<string, unknown> = {};
        for (const c of opts.collections) next[c.key] = [...((s[c.key] as Item[] | undefined) ?? [])];
        let profile = opts.profileKey ? s[opts.profileKey] : undefined;
        for (const r of upserts) {
          if (r.kind === "company_profile" && opts.profileKey) { profile = r.payload; continue; }
          const c = byKind.get(r.kind);
          if (!c) continue;
          const list = next[c.key] as Item[];
          const item = r.payload as Item;
          const i = list.findIndex((x) => x.id === item.id);
          if (i >= 0) list[i] = item;
          else list.push(item);
        }
        for (const c of opts.collections) next[c.key] = (next[c.key] as Item[]).filter((x) => !gone.has(String(x.id)));
        if (opts.profileKey) next[opts.profileKey] = profile && !gone.has(profileRecordId()) ? profile : null;
        return next as Partial<S>;
      });
    },

    clear: opts.clear,

    ready: () =>
      new Promise<void>((resolve) => {
        if (store.persist.hasHydrated()) resolve();
        else store.persist.onFinishHydration(() => resolve());
      }),
  };
}
