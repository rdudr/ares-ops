import Link from "next/link";
import { APP } from "@/lib/ares/app-config";

export const metadata = { title: `Privacy & storage — ${APP.name}` };

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-6">
    <h2 className="font-display text-lg font-semibold text-slate-900">{title}</h2>
    <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">{children}</div>
  </section>
);

/** Cookie, storage and privacy policy of the AR Enterprise field apps. Readable without signing in. */
export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-5 py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800">AR Enterprise · {APP.name}</p>
      <h1 className="mt-2 font-display text-3xl font-semibold text-slate-900">Privacy &amp; storage policy</h1>
      <p className="mt-2 text-sm text-slate-600">Applies to every AR Enterprise field app and the ARES Console. Last updated 27 October 2026.</p>

      <Section title="Cookies">
        <p>
          The field apps use <strong>no cookies</strong>. The ARES Console (for admins) uses one strictly necessary
          sign-in cookie, which is HTTP-only, sent only to <code>ops.arenergyservices.in</code> and removed when you sign
          out or after 30 minutes without activity. There are no advertising, analytics or third-party cookies, so there
          is nothing to accept or decline.
        </p>
      </Section>

      <Section title="What is kept on this device">
        <ul className="list-disc space-y-1 pl-5">
          <li>Your sign-in (a token, never your password) for up to 7 days, so you can work offline.</li>
          <li>The audit you are working on and the readings you recorded, until they have reached the server.</li>
          <li>The list of changes still waiting to sync, and small preferences such as whether you saw this notice.</li>
          <li>Photos and files you take for the audit, until they are uploaded.</li>
        </ul>
        <p>This uses the app&apos;s own storage (local storage and IndexedDB). Other apps and websites cannot read it.</p>
      </Section>

      <Section title="What is sent, and to whom">
        <p>
          Only to the AR Energy Services server (<code>api.arenergyservices.in</code>, run by AR Enterprise), over an
          encrypted connection: what you record for the audits you are assigned to, who recorded it and when, the time you
          spend in the app (to plan the team&apos;s work), and the photos and files you add. Your password is checked by the
          server and stored there only in a scrambled form that cannot be read back.
        </p>
        <p>
          Client names stay private: the public website shows only system-made industry tags. Nothing is sold or shared
          with anyone outside AR Enterprise and the client of the audit.
        </p>
      </Section>

      <Section title="No tracking">
        <p>No analytics, advertising or tracking tools are built in. The Android app checks the public AR Enterprise APK page for newer versions of itself; that request carries no personal data.</p>
      </Section>

      <Section title="Removing your data">
        <p>
          Signing out ends your session; unsynced work stays on the device until you sign in again so it is never lost. To
          remove everything from the device, uninstall the app or clear its data in Android settings. To have server data
          corrected or removed, contact AR Enterprise.
        </p>
      </Section>

      <Section title="Contact">
        <p>AR Enterprise, 504/8 Shree Ghanshyam, Shree Bhaktidham Township, Palanpur Canal Road, Surat 395009 · +91 94262 59992</p>
      </Section>

      <p className="mt-8">
        <Link href="/" className="font-semibold text-cyan-800 underline-offset-4 hover:underline">Back to {APP.name}</Link>
      </p>
    </main>
  );
}
