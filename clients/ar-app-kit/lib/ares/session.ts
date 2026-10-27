// Sign-in, chosen audit and sync bookkeeping for an AR field app. Persisted on the device, so the
// engineer keeps working offline with a cached session. The app's own data lives in its own store;
// this only remembers what still has to reach ARES.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ares, AresError, type AppCode, type AresAudit, type AresUser, type PulledRecord } from "./api";
import { APP } from "./app-config";

const SESSION_DAYS = 7; // matches the ARES app token lifetime

export type Pending = { kind: string; savedAt: number; deleted?: boolean; refused?: string };
export type Conflict = { id: string; reason: string; server: PulledRecord };
export type SyncState = "idle" | "syncing" | "offline" | "blocked" | "signed_out" | "error";

type SessionState = {
  deviceId: string;
  token: string | null;
  tokenUntil: number;
  user: AresUser | null;
  mustChangePw: boolean;
  audits: AresAudit[];
  auditId: string | null;
  since: number;
  versions: Record<string, number>;
  pending: Record<string, Pending>;
  conflicts: Conflict[];
  syncState: SyncState;
  syncMessage: string | null;
  lastSyncAt: number | null;

  // The fields the app screens read for the signed-in person.
  userId: string | null;
  displayName: string | null;
  isAuthenticated: () => boolean;
  logout: () => void;

  login: (loginId: string, password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  refreshAudits: () => Promise<void>;
  currentAudit: () => AresAudit | null;
};

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const useAresSession = create<SessionState>()(
  persist(
    (set, get) => ({
      deviceId: newId(),
      token: null,
      tokenUntil: 0,
      user: null,
      mustChangePw: false,
      audits: [],
      auditId: null,
      since: 0,
      versions: {},
      pending: {},
      conflicts: [],
      syncState: "idle",
      syncMessage: null,
      lastSyncAt: null,

      userId: null,
      displayName: null,
      isAuthenticated: () => {
        const s = get();
        return !!s.token && !!s.user && !s.mustChangePw && s.tokenUntil > Date.now();
      },
      // Signing out never deletes unsynced work: callers check pending first (see SignOutButton).
      logout: () => set({ token: null, tokenUntil: 0, syncState: "signed_out", syncMessage: null }),

      login: async (loginId, password) => {
        const r = await ares.login(APP.code as AppCode, loginId.trim(), password, get().deviceId);
        const sameUser = get().user?.id === r.user.id;
        const unsynced = pendingCount(get());
        if (!sameUser && get().user && unsynced > 0) {
          // Never silently drop someone else's work: they must sign in and let it sync first.
          throw new AresError(`This phone still has ${unsynced} unsynced change${unsynced > 1 ? "s" : ""} by ${get().user!.name}. They need to sign in once with internet so it syncs, then you can use this phone.`, 409, "other_user_pending");
        }
        set({
          token: r.token,
          tokenUntil: Date.now() + SESSION_DAYS * 864e5,
          user: r.user,
          userId: r.user.login_id,
          displayName: r.user.name,
          mustChangePw: r.must_change_pw,
          audits: r.audits,
          syncState: "idle",
          syncMessage: null,
          // A different person on this phone starts from a clean slate (their own audits).
          ...(sameUser ? {} : { auditId: null, since: 0, versions: {}, pending: {}, conflicts: [] }),
        });
        if (get().auditId && !r.audits.some((a) => a.id === get().auditId)) set({ auditId: null });
      },

      changePassword: async (current, next) => {
        const token = get().token;
        if (!token) throw new AresError("Please sign in again.", 401);
        await ares.changePassword(token, current, next);
        set({ mustChangePw: false });
        await get().refreshAudits();
      },

      refreshAudits: async () => {
        const token = get().token;
        if (!token) return;
        const r = await ares.me(token);
        set({ audits: r.audits, user: r.user, displayName: r.user.name, userId: r.user.login_id });
      },

      currentAudit: () => get().audits.find((a) => a.id === get().auditId) ?? null,
    }),
    {
      name: `ares-session-${APP.code}`,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        deviceId: s.deviceId, token: s.token, tokenUntil: s.tokenUntil, user: s.user, mustChangePw: s.mustChangePw,
        audits: s.audits, auditId: s.auditId, since: s.since, versions: s.versions, pending: s.pending,
        conflicts: s.conflicts, lastSyncAt: s.lastSyncAt, userId: s.userId, displayName: s.displayName,
      }),
    },
  ),
);

export const pendingCount = (s: Pick<SessionState, "pending">) => Object.values(s.pending).filter((p) => !p.refused).length;
