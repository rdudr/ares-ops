"use client";
// Shared screens for AR field apps: sign in, set own password, pick audit, guard, sync status,
// sign out. Uses the app's own ui components and its APP config (name, logo, accent).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Building2, CheckCircle2, CloudOff, Loader2, LogOut, PlusCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP } from "@/lib/ares/app-config";
import { useAresSession, pendingCount } from "@/lib/ares/session";
import { ares, AresError } from "@/lib/ares/api";
import { finishWork, resolveConflict, retryRefused, switchAudit, syncNow } from "@/lib/ares/sync";
import { appBinding } from "@/lib/ares-binding";
import { useIsClient, useOnline } from "@/lib/ares/client-state";
import { cn } from "@/lib/utils";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="ar-auth flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-2xl shadow-slate-900/15 backdrop-blur-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/logo.png" alt={`${APP.name} logo`} className="mb-3 h-28 w-28 rounded-2xl bg-white object-contain" />
          <h1 className="text-2xl font-semibold text-slate-900">{APP.name}</h1>
          <p className="mt-1 text-sm text-slate-600">{APP.tagline}</p>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-800">AR Enterprise</p>
        </div>
        {children}
      </div>
    </main>
  );
}

const errorText = (e: unknown) => (e instanceof AresError || e instanceof Error ? e.message : "Something went wrong.");

/** Sign in with the person's ARES Login ID. The same ID works in every AR app they are given. */
export function AresLoginScreen() {
  const router = useRouter();
  const login = useAresSession((s) => s.login);
  const online = useOnline();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (useAresSession.getState().isAuthenticated()) router.replace(useAresSession.getState().auditId ? "/dashboard" : "/audits");
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(loginId, password);
      const s = useAresSession.getState();
      router.replace(s.mustChangePw ? "/change-password" : s.auditId ? "/dashboard" : "/audits");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      {!online && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          You are offline. Signing in needs the internet once; after that the app works offline for 7 days.
        </div>
      )}
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="ares-login">Login ID</Label>
          <Input id="ares-login" autoComplete="username" value={loginId} onChange={(e) => setLoginId(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ares-password">Password</Label>
          <Input id="ares-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !online}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-[11px] leading-relaxed text-slate-600">
          Use the Login ID your AR Enterprise admin gave you. Your work is saved on this phone and syncs to the team automatically.
        </p>
      </form>
    </Frame>
  );
}

/** First sign-in with a temporary password: the person sets their own. */
export function ChangePasswordScreen() {
  const router = useRouter();
  const changePassword = useAresSession((s) => s.changePassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.success("Password saved");
      router.replace("/audits");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <p className="mb-4 text-sm text-slate-700">You signed in with a temporary password. Choose your own to continue.</p>
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="cp-current">Temporary password</Label>
          <Input id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cp-next">New password</Label>
          <Input id="cp-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          <p className="text-[11px] text-slate-600">At least 10 characters, with letters and numbers.</p>
        </div>
        {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save password"}</Button>
      </form>
    </Frame>
  );
}

/** The audits this person is assigned to. All data in the app belongs to the chosen audit. */
const SELECT = "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:border-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700/30";

/**
 * Starts an audit from the phone: company, plant, sector and cluster. The server creates it, assigns
 * it to this person and gives the plant its public industry tag; managers see it in the Console.
 */
function NewAuditForm({ onCreated, onCancel }: { onCreated: (id: string) => Promise<void>; onCancel?: () => void }) {
  const token = useAresSession((s) => s.token);
  const online = useOnline();
  const [sectors, setSectors] = useState<Record<string, string> | null>(null);
  const [form, setForm] = useState({ client_name: "", site_name: "", sector: "", cluster: "", title: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !online || sectors) return;
    ares.auditOptions(token).then((r) => setSectors(r.sectors)).catch((e) => setError(errorText(e)));
  }, [token, online, sectors]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: k === "cluster" ? e.target.value.replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ares.createAudit(token, { ...form, title: form.title.trim() || undefined });
      useAresSession.setState({ audits: r.audits });
      await onCreated(r.audit_id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!online) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden /> Starting a new audit needs internet once. After that, everything works offline.
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-labelledby="new-audit">
      <h3 id="new-audit" className="text-sm font-semibold text-slate-900">Start a new audit</h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="na-client">Company name</Label>
        <Input id="na-client" required maxLength={120} autoComplete="organization" value={form.client_name} onChange={set("client_name")} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="na-site">Plant or unit</Label>
        <Input id="na-site" required maxLength={120} value={form.site_name} onChange={set("site_name")} aria-describedby="na-site-hint" />
        <p id="na-site-hint" className="text-xs text-slate-600">The site you are at, as the company calls it.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="na-sector">Sector</Label>
          <select id="na-sector" required className={SELECT} value={form.sector} onChange={set("sector")} disabled={!sectors}>
            <option value="" disabled>{sectors ? "Choose" : "Loading…"}</option>
            {sectors && Object.entries(sectors).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="na-cluster">Cluster code</Label>
          <Input id="na-cluster" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" autoCapitalize="characters" value={form.cluster} onChange={set("cluster")} aria-describedby="na-cluster-hint" />
        </div>
      </div>
      <p id="na-cluster-hint" className="-mt-1 text-xs text-slate-600">Three letters for the town or industrial cluster, such as SRT for Surat. It forms the public industry tag; the company name is never shown publicly.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="na-title">Audit title (optional)</Label>
        <Input id="na-title" maxLength={120} value={form.title} onChange={set("title")} aria-describedby="na-title-hint" />
        <p id="na-title-hint" className="text-xs text-slate-600">Left empty, it is called “Energy audit”.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !sectors}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlusCircle className="size-4" aria-hidden />} Create and open
        </Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

export function AuditPickerScreen() {
  const router = useRouter();
  const audits = useAresSession((s) => s.audits);
  const auditId = useAresSession((s) => s.auditId);
  const refreshAudits = useAresSession((s) => s.refreshAudits);
  const pending = useAresSession(pendingCount);
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const s = useAresSession.getState();
    if (!s.token) { router.replace("/login"); return; }
    if (s.mustChangePw) { router.replace("/change-password"); return; }
    if (online) refreshAudits().catch(() => {});
  }, [online, refreshAudits, router]);

  /** A newly created audit opens on the plant details page, so the company profile comes first. */
  async function openNew(id: string) {
    await switchAudit(id, appBinding);
    toast.success("Audit created. Fill in the plant details to begin.");
    router.push("/company");
  }

  async function choose(id: string) {
    if (id === auditId) { router.push("/dashboard"); return; }
    setBusy(id);
    try {
      await switchAudit(id, appBinding);
      router.push("/dashboard");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame>
      <h2 className="mb-1 text-base font-semibold text-slate-900">Choose the audit you are working on</h2>
      <p className="mb-4 text-xs text-slate-600">Your audits and the ones your admin added you to. At a new plant, start a new audit.</p>
      {pending > 0 && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {pending} change{pending > 1 ? "s" : ""} still waiting to sync. You can switch audit once they have reached the server.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {audits.length === 0 && <p className="text-sm text-slate-600">No audits yet. Start one below for the plant you are at.</p>}
        {audits.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => void choose(a.id)}
            disabled={!!busy}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
              a.id === auditId ? "border-cyan-300 bg-cyan-50" : "border-slate-200 hover:bg-slate-50",
            )}
          >
            <Building2 className="size-5 shrink-0 text-cyan-800" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-900">{a.title}</span>
              <span className="block truncate text-xs text-slate-600">{a.site_name} · {a.industry_tag} · {a.fy}</span>
            </span>
            {busy === a.id ? <Loader2 className="size-4 animate-spin" /> : a.id === auditId ? <CheckCircle2 className="size-4 text-cyan-800" /> : null}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {pending > 0 ? null : audits.length === 0 || creating ? (
          <NewAuditForm onCreated={openNew} onCancel={audits.length ? () => setCreating(false) : undefined} />
        ) : (
          <Button type="button" variant="secondary" className="w-full gap-2" onClick={() => setCreating(true)}>
            <PlusCircle className="size-4" aria-hidden /> Start a new audit
          </Button>
        )}
      </div>
    </Frame>
  );
}

/** Lets the app's screens render only for a signed-in person with an audit chosen. */
export function AresGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isClient = useIsClient();
  const token = useAresSession((s) => s.token);
  const mustChangePw = useAresSession((s) => s.mustChangePw);
  const auditId = useAresSession((s) => s.auditId);
  const authed = useAresSession((s) => s.isAuthenticated());
  const ready = isClient && authed && !!auditId;

  useEffect(() => {
    if (!isClient) return;
    if (!token || !authed) router.replace(mustChangePw && token ? "/change-password" : "/login");
    else if (!auditId) router.replace("/audits");
  }, [isClient, token, authed, mustChangePw, auditId, router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-cyan-600 border-t-transparent" />
      </div>
    );
  }
  return <>{children}</>;
}

const ago = (t: number | null) => {
  if (!t) return "not yet";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Header badge: synced / waiting to sync N / offline / blocked, plus conflicts and refusals. */
export function SyncStatus() {
  const s = useAresSession();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("#sync-panel, [aria-controls=sync-panel]")) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);
  const pending = pendingCount(s);
  const refused = Object.entries(s.pending).filter(([, p]) => p.refused);
  const problems = s.conflicts.length + refused.length;
  const audit = s.currentAudit();

  const label =
    s.syncState === "blocked" ? "Access stopped"
      : s.syncState === "signed_out" ? "Sign in to sync"
        : s.syncState === "syncing" ? "Syncing…"
          : s.syncState === "offline" ? `Offline · ${pending} waiting`
            : pending ? `Waiting to sync: ${pending}`
              : `Synced ${ago(s.lastSyncAt)}`;
  const tone =
    s.syncState === "blocked" || s.syncState === "error" || problems ? "border-red-300 bg-red-50 text-red-800"
      : s.syncState === "offline" || pending ? "border-amber-300 bg-amber-50 text-amber-800"
        : "border-emerald-300 bg-emerald-50 text-emerald-800";
  const Icon = s.syncState === "syncing" ? Loader2 : s.syncState === "offline" ? CloudOff : s.syncState === "blocked" ? ShieldAlert : problems ? AlertTriangle : CheckCircle2;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="sync-panel"
        aria-label={`Sync status: ${label}${problems ? `, ${problems} to check` : ""}`}
        className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2", tone)}
      >
        <Icon className={cn("size-4", s.syncState === "syncing" && "animate-spin")} />
        {label}
        {problems > 0 && <span className="ml-1 rounded-full bg-red-700 px-1.5 text-[10px] text-white">{problems}</span>}
      </button>
      {open && (
        <div
          id="sync-panel"
          role="dialog"
          aria-label="Sync details"
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-xl shadow-slate-900/10"
        >
          {audit && <p className="mb-2 text-xs text-slate-600">Audit: <span className="text-slate-800">{audit.title}</span> · {audit.industry_tag}</p>}
          {s.syncMessage && <p className="mb-3 text-xs text-slate-700">{s.syncMessage}</p>}
          {s.conflicts.map((c) => (
            <div key={c.id} className="mb-3 rounded-lg border border-red-200 p-3">
              <p className="text-xs text-red-800">{c.reason}</p>
              <p className="mt-1 text-[11px] text-slate-600">Record {c.server.tag ?? c.id.slice(0, 8)}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => resolveConflict(c.id, "theirs")}>Use theirs</Button>
                <Button size="sm" onClick={() => resolveConflict(c.id, "mine")}>Keep mine</Button>
              </div>
            </div>
          ))}
          {refused.map(([id, p]) => (
            <div key={id} className="mb-3 rounded-lg border border-red-200 p-3">
              <p className="text-xs text-red-800">{p.refused}</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => retryRefused(id)}>Try again</Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void syncNow()} disabled={s.syncState === "syncing"}>
              <RefreshCw className="size-4" /> Sync now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (window.location.href = "/audits")}>Change audit</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Sign out without ever losing work: unsynced changes are synced first, or kept on the phone. */
export function SignOutButton() {
  const router = useRouter();
  const logout = useAresSession((s) => s.logout);
  const pending = useAresSession(pendingCount);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await finishWork();
      const left = pendingCount(useAresSession.getState());
      if (left > 0 && !confirm(`${left} change${left > 1 ? "s have" : " has"} not reached the server yet. They stay saved on this phone and sync when you sign in again. Sign out anyway?`)) return;
      logout();
      router.replace("/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => void signOut()} disabled={busy} className="gap-1.5">
      {busy ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
      Sign out{pending ? ` (${pending} unsynced)` : ""}
    </Button>
  );
}
