// ARES app API client — shared by every AR Enterprise field app (copied into lib/ares/).
// Contract: ares-ops/docs/SYNC_API.md. No secrets here: each person signs in with their own ARES ID.

export const ARES_API = (process.env.NEXT_PUBLIC_ARES_API || "https://api.arenergyservices.in").replace(/\/$/, "");

export type AppCode = "survey" | "textile" | "air" | "pump" | "cool" | "heat" | "power" | "bills" | "solar" | "report";

export type AresAudit = {
  id: string;
  title: string;
  fy: string;
  status: string;
  site_name: string;
  industry_tag: string;
};

export type AresUser = { id: string; name: string; login_id: string };

export type PushRecord = {
  id: string;
  audit_id: string;
  kind: string;
  tag: string | null;
  taken_at: number;
  saved_at: number;
  base_version?: number;
  payload: Record<string, unknown>;
};

export type PulledRecord = PushRecord & {
  version: number;
  synced_at: number;
  recorded_by: string;
  updated_by_name: string | null;
};

export type PushResult = {
  id: string;
  status: "stored" | "updated" | "unchanged" | "conflict" | "refused";
  version?: number;
  reason?: string;
  server?: PulledRecord;
};

export type WorkSession = { id: string; audit_id: string; started_at: number; ended_at: number | null; records: number };

export type SyncResponse = {
  results: PushResult[];
  records: PulledRecord[];
  backfilled_audits: string[];
  more: boolean;
  next_since: number;
  server_time: number;
};

/** Any refusal from ARES. `code` tells the app what to do (see SYNC_API.md §4). */
export class AresError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
  /** Access was taken away: stop syncing, keep local data, show the message. */
  get blocked() {
    return ["status_hold", "status_revoked", "app_revoked", "no_app_access"].includes(this.code ?? "");
  }
  get signedOut() {
    return this.status === 401;
  }
  get offline() {
    return this.status === 0;
  }
}

async function call<T>(method: string, path: string, opts: { token?: string | null; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ARES_API}${path}`, {
      method,
      headers: {
        ...(opts.raw ? { "Content-Type": "application/octet-stream" } : opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new AresError("No connection to the AR Energy Services server.", 0, "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AresError(data.error || `Server error (${res.status})`, res.status, data.code);
  return data as T;
}

export const ares = {
  login: (app: AppCode, loginId: string, password: string, deviceId: string) =>
    call<{ token: string; user: AresUser; must_change_pw: boolean; audits: AresAudit[] }>("POST", "/api/device/login", {
      body: { app, login_id: loginId, password, device_id: deviceId },
    }),
  changePassword: (token: string, current: string, next: string) =>
    call<{ ok: true }>("POST", "/api/device/change-password", { token, body: { current, next } }),
  me: (token: string) => call<{ user: AresUser; app: AppCode; audits: AresAudit[] }>("GET", "/api/device/me", { token }),
  sync: (token: string, body: { since: number; records: PushRecord[]; sessions: WorkSession[] }) =>
    call<SyncResponse>("POST", "/api/sync", { token, body }),
  /** Plant details already saved for this audit by any AR app (to reuse instead of retyping). */
  companyProfiles: (token: string, auditId: string) =>
    call<CompanyProfilesResponse>("GET", `/api/device/company-profiles?audit_id=${encodeURIComponent(auditId)}`, { token }),
};

export type SharedProfile = {
  companyName: string;
  area?: string;
  district?: string;
  state?: string;
  pincode?: string;
  overallConsumption?: string | number;
};

export type CompanyProfilesResponse = {
  audit_id: string;
  site: { name: string; client_name: string };
  profiles: { app: AppCode; saved_at: number; saved_by: string | null; profile: SharedProfile }[];
};

/** Display names of the AR apps, by code. */
export const APP_NAMES: Record<string, string> = {
  survey: "BRIEF", textile: "JET", air: "Air Findings", pump: "Pump Testing", cool: "AHU & Cooling", heat: "Boiler & Fuel",
  power: "Power Quality", bills: "Bills", solar: "Solar", report: "Report Studio",
};

export type UploadMeta = {
  id: string;
  audit_id: string;
  kind: "photo" | "thermal" | "scan" | "instrument_file";
  equipment_tag?: string | null;
  pair_id?: string | null;
  caption: string;
  taken_at?: number;
  name?: string;
};

const CHUNK = 2 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upload a photo or file in pieces; safe to call again after a dropped connection — it resumes. */
export async function uploadFile(token: string, file: Blob, meta: UploadMeta): Promise<{ id: string; url: string | null }> {
  const bytes = await file.arrayBuffer();
  const announce = await call<{ file: { id: string; received: number; status: string; url: string | null } }>("POST", "/api/files", {
    token,
    body: { ...meta, mime: file.type, size: bytes.byteLength, sha256: await sha256Hex(bytes) },
  });
  let { received, status, url } = announce.file;
  while (status !== "ready") {
    try {
      const r = await call<{ file: { received: number; status: string; url: string | null } }>(
        "PUT", `/api/files/${encodeURIComponent(meta.id)}/content?offset=${received}`,
        { token, raw: bytes.slice(received, received + CHUNK) },
      );
      ({ received, status, url } = r.file);
    } catch (e) {
      if (e instanceof AresError && e.code === "wrong_offset") {
        const s = await call<{ file: { received: number; status: string; url: string | null } }>("GET", `/api/files/${encodeURIComponent(meta.id)}/status`, { token });
        ({ received, status, url } = s.file);
        continue;
      }
      throw e;
    }
  }
  return { id: meta.id, url };
}
