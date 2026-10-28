// The sync engine: notices every change in the app's own store, queues it, and pushes / pulls with
// ARES automatically — on start, when the network comes back, a few seconds after each change and
// every few minutes. No buttons, no files. Each app provides a small binding (lib/ares-binding.ts).
import { ares, AresError, type PulledRecord, type PushRecord, type WorkSession } from "./api";
import { useAresSession, type Pending } from "./session";
import { uploadPendingPhotos } from "@/lib/ares/photos";

/** One piece of the app's data as ARES stores it. */
export type LocalRecord = { id: string; kind: string; tag: string | null; takenAt: number; payload: Record<string, unknown> };

export interface AppBinding {
  /** Every record of the current audit, from the app's store. */
  snapshot(): LocalRecord[];
  /** Call `listener` whenever the app's store changes. */
  subscribe(listener: () => void): () => void;
  /** Put teammates' records into the app's store (upserts) and remove deleted ones. */
  apply(upserts: PulledRecord[], deletedIds: string[]): void;
  /** Empty the app's store (when switching audit). */
  clear(): void;
  /** Resolves once the app's store has loaded from the phone's storage. */
  ready?(): Promise<void>;
}

const DEBOUNCE_MS = 3000;
const EVERY_MS = 3 * 60 * 1000;
const MAX_BATCH = 400;

let binding: AppBinding | null = null;
let baseline = new Map<string, string>(); // id -> JSON of the last known state (to detect changes)
let applying = false;
let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let work: WorkSession | null = null;
let stopFns: Array<() => void> = [];

const S = () => useAresSession.getState();
const fingerprint = (r: LocalRecord) => JSON.stringify([r.kind, r.tag, r.payload]);
const newId = () => crypto.randomUUID();

function takeBaseline() {
  baseline = new Map((binding?.snapshot() ?? []).map((r) => [r.id, fingerprint(r)]));
}

/** Compare the store with the last known state and queue whatever changed. */
function detectChanges() {
  if (!binding || applying) return;
  const now = Date.now();
  const current = new Map(binding.snapshot().map((r) => [r.id, r]));
  const pending = { ...S().pending };
  let changed = 0;
  for (const [id, r] of current) {
    const fp = fingerprint(r);
    if (baseline.get(id) !== fp) {
      pending[id] = { kind: r.kind, savedAt: now };
      baseline.set(id, fp);
      changed++;
    }
  }
  for (const id of [...baseline.keys()]) {
    if (!current.has(id)) {
      const kind = pending[id]?.kind ?? "deleted";
      pending[id] = { kind, savedAt: now, deleted: true };
      baseline.delete(id);
      changed++;
    }
  }
  if (!changed) return;
  if (work) work.records += changed;
  useAresSession.setState({ pending });
  schedule(DEBOUNCE_MS);
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), ms);
}

function startWork() {
  const auditId = S().auditId;
  work = auditId ? { id: newId(), audit_id: auditId, started_at: Date.now(), ended_at: null, records: 0 } : null;
}

/** Push this phone's queue, then pull teammates' changes. Safe to call any time. */
export async function syncNow(): Promise<void> {
  if (running) { again = true; return; }
  const s = S();
  if (!binding || !s.token || !s.auditId || s.mustChangePw) return;
  if (s.syncState === "blocked") return;
  running = true;
  useAresSession.setState({ syncState: "syncing" });
  try {
    let more = true;
    while (more) {
      const st = S();
      const local = new Map(binding.snapshot().map((r) => [r.id, r]));
      const inConflict = new Set(st.conflicts.map((c) => c.id));
      const sending = Object.entries(st.pending).filter(([id, p]) => !p.refused && !inConflict.has(id)).slice(0, MAX_BATCH);
      const records: PushRecord[] = [];
      for (const [id, p] of sending) {
        if (inConflict.has(id)) continue;
        const r = local.get(id);
        const base = st.versions[id];
        if (p.deleted || !r) {
          if (base === undefined) continue; // never reached the server: nothing to delete there
          records.push({ id, audit_id: st.auditId!, kind: p.kind, tag: null, taken_at: p.savedAt, saved_at: p.savedAt, base_version: base, payload: { _deleted: true } });
        } else {
          records.push({ id, audit_id: st.auditId!, kind: r.kind, tag: r.tag, taken_at: r.takenAt, saved_at: p.savedAt, ...(base !== undefined ? { base_version: base } : {}), payload: r.payload });
        }
      }
      const sessions = work ? [{ ...work }] : [];
      const res = await ares.sync(st.token!, { since: st.since, records, sessions });

      // Results of what we sent.
      const versions = { ...S().versions };
      const pending = { ...S().pending };
      const conflicts = [...S().conflicts];
      for (const r of res.results) {
        const sent = sending.find(([id]) => id === r.id)?.[1];
        const stillSame = sent && pending[r.id]?.savedAt === sent.savedAt; // not edited again meanwhile
        if (r.status === "stored" || r.status === "updated" || r.status === "unchanged") {
          if (r.version !== undefined) versions[r.id] = r.version;
          if (stillSame) delete pending[r.id];
          if (sent?.deleted && stillSame) delete versions[r.id];
        } else if (r.status === "conflict" && r.server) {
          if (!conflicts.some((c) => c.id === r.id)) conflicts.push({ id: r.id, reason: r.reason ?? "Changed by someone else.", server: r.server });
        } else if (r.status === "refused" && pending[r.id]) {
          pending[r.id] = { ...(pending[r.id] as Pending), refused: r.reason ?? "Refused by the server." };
        }
      }
      // Records never sent (deleted before reaching the server) leave the queue.
      for (const [id, p] of sending) if (p.deleted && versions[id] === undefined && pending[id]?.savedAt === p.savedAt) delete pending[id];

      // Teammates' changes. Our own unsent edits win locally until they are pushed.
      const upserts: PulledRecord[] = [];
      const deletes: string[] = [];
      for (const r of res.records) {
        versions[r.id] = r.version;
        if (pending[r.id] && !pending[r.id].refused) continue;
        if ((r.payload as { _deleted?: boolean })._deleted) deletes.push(r.id);
        else upserts.push(r);
      }
      if (upserts.length || deletes.length) {
        applying = true;
        try { binding.apply(upserts, deletes); } finally { applying = false; }
        takeBaseline();
      }
      useAresSession.setState({ versions, pending, conflicts, since: res.next_since });
      more = res.more || records.length === MAX_BATCH;
    }
    useAresSession.setState({ syncState: "idle", syncMessage: null, lastSyncAt: Date.now() });
    void uploadPendingPhotos(); // photos follow the records they belong to
  } catch (e) {
    if (e instanceof AresError) {
      if (e.offline) useAresSession.setState({ syncState: "offline", syncMessage: "Offline — changes are saved on this phone and will sync automatically." });
      else if (e.signedOut) useAresSession.setState({ syncState: "signed_out", syncMessage: "Please sign in again. Your work is kept on this phone.", token: null });
      else if (e.blocked) useAresSession.setState({ syncState: "blocked", syncMessage: e.message });
      else if (e.code === "password_change_required") useAresSession.setState({ mustChangePw: true, syncState: "idle" });
      else useAresSession.setState({ syncState: "error", syncMessage: e.message });
    } else {
      useAresSession.setState({ syncState: "error", syncMessage: String(e) });
    }
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
}

/** Start the engine for this app. Returns a stop function. Call once from the app shell. */
export function startSync(b: AppBinding): () => void {
  stopSync();
  const generation = ++startGeneration;
  // Wait until the app's data has loaded from storage, or loading it would look like new edits.
  void (b.ready ? b.ready() : Promise.resolve()).then(() => {
    if (generation === startGeneration) attach(b);
  });
  return stopSync;
}

let startGeneration = 0;

function attach(b: AppBinding) {
  binding = b;
  takeBaseline();
  // Keep one work session per sitting: a restart of the engine (e.g. after choosing the audit)
  // continues the open session instead of starting a second one.
  if (!work || work.ended_at !== null || work.audit_id !== S().auditId) startWork();
  const unsub = b.subscribe(detectChanges);
  const online = () => { if (S().syncState === "offline") useAresSession.setState({ syncState: "idle" }); void syncNow(); };
  const visibility = () => {
    if (document.visibilityState === "hidden") {
      if (work) work.ended_at = Date.now();
      void syncNow();
    } else {
      startWork();
      void syncNow();
    }
  };
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visibility);
  const every = setInterval(() => void syncNow(), EVERY_MS);
  stopFns = [unsub, () => window.removeEventListener("online", online), () => document.removeEventListener("visibilitychange", visibility), () => clearInterval(every)];
  void syncNow();
}

export function stopSync() {
  startGeneration++;
  for (const f of stopFns) f();
  stopFns = [];
  if (timer) clearTimeout(timer);
  binding = null;
}

/** End the current work session (e.g. when signing out) and send it. */
export async function finishWork() {
  if (work) work.ended_at = Date.now();
  await syncNow();
  work = null;
}

/** Switch to another audit. Refuses while this phone still has unsent changes. */
export async function switchAudit(auditId: string, b: AppBinding) {
  const s = S();
  if (Object.values(s.pending).some((p) => !p.refused)) {
    throw new Error("This phone still has changes that have not reached the server. Connect to the internet and let them sync first.");
  }
  await finishWork();
  applying = true;
  try { b.clear(); } finally { applying = false; }
  useAresSession.setState({ auditId, since: 0, versions: {}, pending: {}, conflicts: [] });
  startSync(b);
}

/** Resolve a conflict: keep this phone's version (sent again) or take the server's. */
export function resolveConflict(id: string, keep: "mine" | "theirs") {
  const s = S();
  const c = s.conflicts.find((x) => x.id === id);
  if (!c) return;
  const versions = { ...s.versions, [id]: c.server.version };
  const pending = { ...s.pending };
  if (keep === "theirs") {
    delete pending[id];
    if (binding) {
      applying = true;
      try {
        if ((c.server.payload as { _deleted?: boolean })._deleted) binding.apply([], [id]);
        else binding.apply([c.server], []);
      } finally { applying = false; }
      takeBaseline();
    }
  } else if (pending[id]) {
    pending[id] = { ...pending[id], savedAt: Date.now(), refused: undefined };
  }
  useAresSession.setState({ conflicts: s.conflicts.filter((x) => x.id !== id), versions, pending });
  schedule(200);
}

/** Retry a refused change after the person fixed it (editing it also clears the refusal). */
export function retryRefused(id: string) {
  const p = S().pending[id];
  if (!p) return;
  useAresSession.setState({ pending: { ...S().pending, [id]: { ...p, refused: undefined, savedAt: Date.now() } } });
  schedule(200);
}
