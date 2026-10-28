"use client";
// "Use existing company or start new": offers the plant details already saved for this audit in any
// AR app, so engineers do not type the company name and address in every app.
import { useEffect, useState } from "react";
import { Building2, Check, Loader2, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ares, APP_NAMES, type CompanyProfilesResponse, type SharedProfile } from "@/lib/ares/api";
import { useAresSession } from "@/lib/ares/session";
import { APP } from "@/lib/ares/app-config";
import { useOnline } from "@/lib/ares/client-state";

/** Text values for a form, so `setForm((f) => ({ ...f, ...asFormValues(p) }))` works in every app. */
export function asFormValues(p: SharedProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (v != null && v !== "") out[k] = String(v);
  return out;
}

/** The form with the chosen details filled in — only the fields this app's form actually has. */
export function fillForm<T extends Record<string, unknown>>(form: T, p: SharedProfile): T {
  const v = asFormValues(p);
  return { ...form, ...Object.fromEntries(Object.entries(v).filter(([k]) => k in form)) };
}

export function ExistingCompanyPicker({ hasDetails, onPick }: { hasDetails: boolean; onPick: (p: SharedProfile) => void }) {
  const token = useAresSession((s) => s.token);
  const auditId = useAresSession((s) => s.auditId);
  const online = useOnline();
  const [data, setData] = useState<CompanyProfilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token || !auditId || !online) return;
    let live = true;
    setLoading(true);
    ares.companyProfiles(token, auditId)
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token, auditId, online]);

  // One option per distinct company (newest first), plus the plant as registered in ARES.
  const options: { key: string; label: string; detail: string; profile: SharedProfile }[] = [];
  const seen = new Set<string>();
  for (const p of data?.profiles ?? []) {
    const k = JSON.stringify(p.profile);
    if (seen.has(k)) continue;
    seen.add(k);
    const where = [p.profile.area, p.profile.district, p.profile.state, p.profile.pincode].filter(Boolean).join(", ");
    options.push({
      key: `${p.app}-${p.saved_at}`,
      label: p.profile.companyName,
      detail: `${where || "No address yet"} · saved in ${p.app === APP.code ? "this app" : APP_NAMES[p.app] ?? p.app}${p.saved_by ? ` by ${p.saved_by}` : ""} on ${new Date(p.saved_at).toLocaleDateString("en-IN")}`,
      profile: p.profile,
    });
  }
  if (data && !options.some((o) => o.label === data.site.client_name)) {
    options.push({
      key: "ares-site",
      label: data.site.client_name,
      detail: `${data.site.name} · as registered for this audit`,
      profile: { companyName: data.site.client_name, area: data.site.name },
    });
  }

  // A brand-new audit (nothing saved by any app yet) with an empty form: fill in what the engineer
  // typed when starting it, so the company name is never entered twice.
  const only = options.length === 1 && options[0].key === "ares-site" ? options[0] : null;
  useEffect(() => {
    if (only && !hasDetails && !chosen) { onPick(only.profile); setChosen(only.key); }
  }, [only, hasDetails, chosen, onPick]);

  if (dismissed || (!loading && options.length === 0)) return null;

  return (
    <section aria-labelledby="existing-company" className="mb-4 rounded-2xl border border-cyan-200 bg-cyan-50/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Building2 className="size-5 text-cyan-800" aria-hidden />
        <h2 id="existing-company" className="text-sm font-semibold text-slate-900">
          {hasDetails ? "Plant details known for this audit" : "Use existing company or start new"}
        </h2>
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="size-4 animate-spin" aria-hidden /> Looking up this audit…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {options.map((o) => (
            <li key={o.key} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{o.label}</p>
                <p className="text-xs text-slate-600">{o.detail}</p>
              </div>
              <Button size="sm" variant={chosen === o.key ? "secondary" : "default"} onClick={() => { onPick(o.profile); setChosen(o.key); }}>
                {chosen === o.key ? <><Check className="size-4" aria-hidden /> Filled in</> : "Use these details"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => setDismissed(true)}>
        <PlusCircle className="size-4" aria-hidden /> Start new company details
      </Button>
    </section>
  );
}
