# AR app guide

How every AR Enterprise field app is built, how it looks, how it keeps data safe without internet,
how people sign in, and how its data reaches Report Studio. Follow it for any new process app, so
the new app looks and behaves like the others and its data lands in the same place.

Rules about names, domains and security live in `docs/PLATFORM_RULES.md` (website repo). The wire
formats live in `SYNC_API.md` (sync and files) and `READ_API.md` (reading an audit). This guide links
them together.

---

## 1. The apps today

| App | Code | Android id | APK file | Repo |
|---|---|---|---|---|
| BRIEF (plant electrical survey) | `survey` | `com.arenterprise.brief` | `ar-brief-v<version>.apk` | `ares-brief` |
| JET (jet dyeing machines) | `textile` | `com.arenterprise.jet` | `ar-jet-v<version>.apk` | `ares-jet` |
| Pump Testing | `pump` | `com.arenterprise.pumptesting` | `ar-pump-testing-v<version>.apk` | `ares-pump` |
| Air Findings (compressed air) | `air` | `com.arenterprise.airfindings` | `ar-air-findings-v<version>.apk` | `ares-air` |
| Boiler & Fuel | `heat` | `com.arenterprise.boilerfuel` | `ar-boiler-fuel-v<version>.apk` | `ares-boiler` |
| AHU & Cooling | `cool` | `com.arenterprise.ahucooling` | `ar-ahu-cooling-v<version>.apk` | `ares-cooling` |

The **code** is how ARES files the app's data. It never changes once data exists under it. The
Android id never changes either: a different id installs as a separate app and the old app's data
stays behind in the old one.

---

## 2. Making a new app

1. **Start from the kit.** If the app adapts a KISEM app, add it to `APPS` in
   `clients/ar-app-kit/make-ar-app.py` (code, name, tagline, logo, accent colour, Android id, APK
   name, KISEM formula files to vendor) and run `python make-ar-app.py <key>`. For a brand-new
   process, copy the finished `ares-pump` and replace its screens. Either way the app gets the ARES
   sign-in, sync engine, screens, privacy page, update banner, APK script and workflow.
2. **Name it** in `lib/ares/app-config.ts`: `code`, `name`, `apk` (file name stem) and `tagline`.
   This file is the one place an app names itself; the build, the update check and the download
   page all read it.
3. **Bind its data** in `lib/ares-binding.ts` (see section 3).
4. **Company page:** put `<ExistingCompanyPicker … onPick={(p) => setForm((f) => fillForm(f, p))} />`
   above the form, and save the profile under `profile` in the store.
5. **Report page:** offers local copies only (PDF / Excel download and Android share) and says the
   team needs nothing sent. No email forms, no file hand-offs (section 6).
6. **Apply the look:** `python clients/ar-app-kit/apply-light.py <app dir>` (theme, kit components,
   layout, shell fixes, then `restyle.py`). Both are safe to run again.
7. **Check:** `npx tsc --noEmit`, sign in against a local ARES, save a record offline, reconnect and
   see it arrive. Then `node scripts/android-apk.mjs` for a test APK.
8. **Publish:** create the GitHub repo (private), add the secrets from section 8, push `main`.

---

## 3. Data model

Everything an engineer records belongs to one **audit** (one client site, one financial year:
`AU-2627-0001`). Inside an audit, each app's data is a set of **records**:

| Field | Meaning |
|---|---|
| `id` | UUID made on the phone when the item is first saved. Never reused. |
| `kind` | What the record is, in the app's words: `pump_test`, `compressor`, `panel`, `jet`… |
| `tag` | Equipment tag, unique per audit and app (ignoring case and extra spaces), or none. |
| `taken_at` / `saved_at` | When the reading was taken / last edited, phone time (checked against the server). |
| `payload` | The app's own fields, **named as in its Excel export**, so a column means the same thing everywhere. |
| `version` | Set by ARES. Each change bumps it; the phone sends the version it edited (`base_version`). |

The app never builds records by hand. Its binding says which lists in the store are records:

```ts
export const appBinding = collectionBinding(useAppStore, {
  profileKey: "profile",                       // becomes the company_profile record
  collections: [
    { key: "jets", kind: "jet", tag: prefixed("Jet", "jetNo") },   // tag only where it is truly unique
    { key: "entries", kind: "motor_reading" },                      // readings that repeat: no tag
  ],
  clear: () => useAppStore.getState().wipeData(),
});
```

**Give a tag only to things that exist once in a plant** (a pump, a compressor, a panel). ARES then
refuses a second "P-01" in the same audit, which catches double entry by two engineers. Readings,
stages and areas whose names legitimately repeat carry no tag.

### The company profile is the anchor

Each app saves the plant details (company name, area, district, state, pincode, consumption) as a
`company_profile` record. `GET /api/device/company-profiles?audit_id=…` returns every app's saved
profile for the audit plus the site as registered in the Console. The company page shows them as
**"Use existing company or start new"**, so an engineer types the address once per audit, not once
per app. `fillForm` copies only the fields that the app's form actually has.

Photos and instrument files are not records: they go to the file store with a caption that says
what the image shows (`SYNC_API.md` §3).

---

## 4. Look and feel

The apps follow the website (arenergyservices.in): warm paper background, dark ink, one accent per
app taken from its logo.

- **Colours.** `app/globals.css` maps Tailwind's `slate` to the website neutrals (`#fbf9f4` paper …
  `#141812` ink) and `cyan`/`sky` to the app's accent. Screens use `slate-*` for text and surfaces and
  `cyan-*` for the accent, so changing one file re-colours an app. Never hard-code hex colours in a screen.
- **Contrast (WCAG AA, 4.5:1 for text).** Body text `slate-900`/`slate-700`; secondary text no lighter
  than `slate-600` (6.7:1) or `slate-500` (4.9:1). Accent text `-800`. White text only on `-700` or
  darker solid backgrounds. Status colours: text `-800` on a `-50`/`-100` tint.
- **Type.** DM Sans for text, Fraunces for headings (`next/font`). Minimum 12 px; form text 14–16 px.
- **Components.** Use the kit's `components/ui` (Button, Card, Input, Textarea, Label, Badge). Buttons:
  44 px touch height on phones, `h-10` default. Cards: white, `slate-200` border, a slightly stronger
  shadow on hover. No purple gradients, no emoji, no decorative animation.
- **Layout.** Mobile first: one column on phones, the side menu becomes a drawer below `lg`. Tables
  scroll sideways inside their card, never the whole page.
- **Hover and motion.** Small changes only (shadow, background, 1 px lift) and only under
  `motion-safe`; everything respects "reduce motion".

### Keyboard and screen readers

- Every page starts with a **"Skip to content"** link to `<main id="main">`.
- **Focus is always visible**: a solid accent outline (`:focus-visible`), never a faint tint.
- Every field has a **label linked to it** (`<Label htmlFor>` + `id`). `restyle.py` links them.
- **No example placeholders** ("e.g. RISHABH", "Shree Textiles…"). The label and a short hint below
  the field carry the meaning; placeholders are not read reliably and vanish while typing.
- Menus and dialogs: `role="dialog"`, `aria-modal`, close on **Escape** and on clicking outside,
  `aria-expanded` on the button that opens them. Current page marked with `aria-current="page"`.
- Anything clickable is a `<button>` or `<a>`. A clickable table row also needs a button or link
  inside it, so it can be reached with Tab.
- Icons next to text get `aria-hidden`; icon-only buttons get an `aria-label`.

### Words

Plain words an engineer would use on site: "Plant details", "Waiting to sync: 3", "Download PDF".
Say what happened and what to do next ("Could not save the PDF. Check storage space and try again.").

---

## 5. Working without internet

Plants often have no signal in the boiler house or the basement. The apps are built so that **the
phone never waits for the network and nothing typed is ever lost.**

### What is guaranteed

1. **Saved on the phone first.** Every entry goes into the app's own store in the phone's IndexedDB
   the moment it is saved. The app works fully offline: forms, calculations, PDF and Excel copies.
2. **A change waits until the server confirms it.** The sync engine compares the store with what
   ARES last confirmed and queues every new, edited or deleted record. A queued change leaves the
   queue only when ARES answers `stored`, `updated` or `unchanged`. A dropped connection mid-sync
   just means the same change is sent again; ARES matches it by `id`, so it is never doubled.
3. **Deletes travel too.** Deleting an item sends a "deleted" marker, so a teammate's phone removes
   it as well, and the history stays on the server.
4. **Sync happens by itself**: when the app opens, when the network comes back, 3 seconds after a
   change, every 3 minutes, and when the app goes to the background. No sync button, no files.
5. **Nobody overwrites anybody silently.** Each change carries the version it was edited from. If a
   teammate saved the same record in between, ARES returns a **conflict**; the app shows both
   versions and the engineer chooses. A change ARES **refuses** (tag already used, audit closed,
   phone clock ahead, not assigned) stays on the phone with the reason until it is corrected.
6. **The header always shows the state**: "Synced just now", "Offline · 4 waiting", "Waiting to
   sync: 2", or what needs attention. Engineers can see that nothing is lost.
7. **Guards against losing the queue.** Switching audit is refused while changes are still waiting.
   Signing out with changes waiting asks first, and the changes stay on the phone and go up at the
   next sign-in by the same person.
8. **Teammates' work comes down in the same call**, so two engineers on one audit see each other's
   equipment, and someone added to an audit later receives its earlier records.
9. **Clock check.** A phone whose date is more than 5 minutes ahead is asked to set automatic time,
   so "taken at" times in reports are trustworthy.

### Limits to know about

- **Sign in online at least once a week.** The app token lasts 7 days. After that the app asks for a
  sign-in, which needs a connection. Everything recorded stays on the phone meanwhile.
- **One audit at a time per phone**, per app.
- **Uninstalling the app deletes what has not synced.** Installing an update over it keeps
  everything (all builds share one signing key, section 8).
- **Photos go to the AR server.** A captured photo is resized (longest side 2048 px), kept on the
  phone only until ARES confirms it has it, then deleted from the phone. The record stores
  `ares-photo:<id>` in its photo field; ARES links the file to that record (app, record kind, field,
  equipment tag) whichever arrives first, and keeps who took it, when, on which screen and where
  (GPS, when the phone allows location; the Console shows a map link). Waiting photos show in the
  sync badge and in the sign-out warning. Use `savePhotoLocally` / `queuePhoto` and show photos
  with `<PhotoRef value={...} />`.

---

## 6. Sign-in and access

- **One login per person** for every AR app, created by an admin in the Console. Access is given
  **per app** and **per audit**: an engineer sees only the apps and audits they were given.
- **First sign-in** uses a temporary password and must set their own before anything else.
- **Starting work at a new plant:** the audit screen has **Start a new audit** (company, plant,
  sector, 3-letter cluster code). ARES creates the audit "in field", assigns it to that engineer,
  gives the plant its public industry tag and logs it (`audit.created_in_app`), so managers see it in
  the Console and can add the rest of the team. The same company and plant typed again are reused,
  not duplicated. The app then opens the plant details page with the company already filled in.
  This needs internet once; everything after it works offline.
- The app keeps the sign-in (a 7-day token, never the password) in the phone's storage, with a
  stable device id, so it opens straight into work offline.
- **Access can be put on hold or removed** at any time in the Console. The next sync stops, the
  person sees why, and **their unsent data stays on the phone** for an admin to recover.
- **A different person on the same phone** cannot sign in while the previous person still has
  unsent changes: the app names that person and asks them to sign in once online so it syncs. This
  way nobody's work is dropped or sent under someone else's name. Once clear, the new person sees
  only their own audits and starts from an empty store.
- Everything goes over HTTPS to `api.arenergyservices.in` only (Capacitor `allowNavigation`,
  no mixed content). The apps use no cookies and no tracking; the Console uses one sign-in cookie.
  The app's Privacy & storage page says this in plain words.

---

## 7. Report Studio

Report Studio is the tool that turns an audit's data into the client report. It replaces the
PostMan hand-off of the KISEM apps: **there is nothing to send.**

- Field apps sync records to ARES. Report Studio reads the whole audit with
  `GET /api/audits/<id>/data` (`READ_API.md`): every app's records, grouped by app, plus files.
- It signs in as the `report` app, which sees every app's data of the audits that person may use.
- The data is organised around the audit's **company profile** (section 3), so the cover, the plant
  details and every section refer to the same company, whichever app recorded them.
- The field apps' report pages offer the engineer's own copies (PDF, Excel, Android share) for site
  use. Those copies use a plain AR Enterprise page frame.

**Remaining tasks for Report Studio**

- [ ] **Report design and letterhead**: to be defined later (or integrated from an existing design).
      Until then the apps' PDFs use the plain AR page frame; the KISEM letterhead is not used.
- [ ] Build Report Studio itself on the read API (`READ_API.md` is draft v0 until agreed).

---

## 8. Building and releasing the Android apps

- **Build:** `node scripts/android-apk.mjs` (or `npm run android:apk`). It makes the static export,
  generates the Android project with Capacitor (never committed), sets icons, stamps the version, and
  builds a **signed release APK** into `releases/<apk>-v<version>.apk`. It needs JDK 21 (Android
  Studio's own JDK is found automatically) and the Android SDK.
- **Version:** `major.minor` from `package.json`; on GitHub the patch number is the workflow run
  number, so every build is newer than the last. `versionCode` grows with it.
- **Signing:** every AR app is signed with **one AR Enterprise key**, so updates install over the old
  version and keep its data. The key lives outside all repos (on the build laptop in
  `~/.ar-enterprise/android-signing/`, on GitHub as secrets). **Back it up: without it no installed
  app can be updated; a new key means every phone must uninstall, losing unsynced data.**
- **Automatic releases:** `.github/workflows/android-apk.yml` runs on every push to `main`: build,
  sign, then add the APK to **AR-Enterprise-APPS-Repo-** with `tools/publish.mjs`, which updates
  `apps.json` and the download page. Repo secrets: `APK_REPO_TOKEN`, `AR_KEYSTORE_BASE64`,
  `AR_KEYSTORE_PASSWORD`, `AR_KEY_ALIAS`, `AR_KEY_PASSWORD`.
- **Download page:** https://ops.arenergyservices.in/apps/ lists each app's newest
  version first, with size, date, SHA-256 and earlier versions (last 3 files kept per app).
- **Updates on the phone:** the app checks `apps.json` (at most every 6 hours, online only) and,
  when a newer version exists, shows a banner with a download link. Android always asks the person
  to confirm an install from outside the Play Store, so the download is automatic but the install
  is one tap.
