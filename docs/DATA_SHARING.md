# AR data sharing: one company, every app

How the AR field apps (ARES, MLA, Thermo-X, JET-Eff, A-CMP, Pump EFF, AC, AHU & Chiller), the
Power Quality analyser and Report Studio share one company's data through ARES Console, so nobody types
a company twice and nobody merges Excel files by hand. It follows the AR Enterprises design; the
server side already exists in ARES Console (`docs/SYNC_API.md`, `docs/READ_API.md`).

## 1. A company is an audit

The unit everything hangs on is the **audit** in ARES Console:

| | |
|---|---|
| Audit ID | `AU-2627-0007` (made by the Console; never changes) |
| Industry tag | `TX-SRT-001`: sector, cluster and number; safe to show anywhere |
| Client and plant | the company name and the plant (site), kept private to the team |
| Financial year, status | `in_field` → `processing` → `review` → `approved` → `published` / `archived` |

One company with two plants, or the same plant in two years, is two audits. Published and
archived audits accept no new data.

## 2. Where a company comes from

1. **ARES Console → Audits → New audit** (office).
2. **In any app → "Start a new company"** (site): `POST /api/device/audits` with client, plant,
   sector and cluster. A client and plant already registered under the same names are reused, so
   two engineers starting the same plant on the same day get one audit, not two.
3. **Opened from ARES Console**: the person chose the audit in the "What is this for?" dialog; the
   app starts on that company (`?audit=` → session storage `ares-audit`).

## 3. In every app: "Which company?"

When an app starts (after sign-in) it asks, like AR:

- **Continue a company**: the audits from the sign-in answer (`audits`), newest first; the one
  chosen in the Console is at the top.
- **Start a new company**: as in 2.2.
- **Quick check**: work without a company. Nothing is sent to the server; the data stays on the
  phone and in the app's own Excel/PDF exports.

The chosen audit is shown at the top of every screen and can be changed from there.

## 4. The company profile, entered once

Each app keeps its own company form (the same six fields in every AR app): `companyName`,
`area`, `district`, `state`, `pincode`, `overallConsumption`.

- **"Use existing company details"**: the form offers the details already saved for this audit by
  any app (`GET /api/device/company-profiles?audit_id=…`, newest first, with who saved them and in
  which app), plus the client and plant as registered in the Console. One tap fills the form; it
  stays editable.
- Saving the form stores it in the app and sends it as a record of kind `company_profile`, so the
  next app (and Report Studio) gets it.

## 5. Everything else the app records

Each piece of equipment is one **record**, sent with `POST /api/sync`:

| App | code | record kinds |
|---|---|---|
| ARES | `survey` | panels (PCC/MCC), machines, APFC, energy sources, areas and zones |
| MLA | `motor` | motors, long-term monitoring sessions |
| Thermo-X | `heat` | boilers, thermic fluid heaters, fuel and flue-gas tests |
| JET-Eff | `textile` | jet machines, steam traps |
| A-CMP | `air` | compressors (FAD / pump-up tests) |
| Pump EFF | `pump` | pump tests |
| AC, AHU & Chiller | `cool` | AC, chillers, cooling towers |
| Power Quality | `power` | PQ recordings and their analysis |

- A record carries `audit_id`, `kind`, the equipment `tag` (unique per audit and app, so the
  same motor is not entered twice), `taken_at`/`saved_at`, and its `payload` named exactly as the
  app's Excel export, so Report Studio reads the same columns it reads today.
- **Offline first**: records go into a queue on the phone and are sent when there is a
  connection; the same call brings back what the rest of the team recorded for that audit, so
  two engineers on one plant see each other's work.
- **Conflicts**: if two people edit the same record, nothing is overwritten silently: the app
  shows both and the person chooses (`base_version`).
- **Work log**: each sitting is a session (start, end, records), which feeds "working now" and
  the per-person figures on the Console.

## 6. Photos and thermal images

Photos (name-plates, equipment, thermal pairs) are uploaded on their own (`/api/files`, stored on
the Oracle server, checked and private), linked to the audit and the record; the record holds
only a reference (`ares-photo:<file id>`), never the picture itself. Office staff can add thermal
and other images later on the Console's audit page; they land on the same record.

## 7. Who sees what

The whole team uses every app with one login and sees every open audit (team-wide access; see
`TEAM_WIDE_ACCESS`). Paused or removed members are refused on their next call. Everything is in
the Console's activity log.

## 8. The report

Report Studio signs in with the team login and reads one audit's data in one call
(`GET /api/audits/<id>/data`): the company profile, every app's records with who recorded them,
and the photos. Its chapters fill from that, and its assessment team from the profile cards. The
final report is saved to the Console against the audit, and finalising the audit closes it to new
data.

## 9. Rollout

1. **MLA first** (pilot): "Which company?", "Use existing company details", record and photo sync.
2. Then ARES, Thermo-X, JET-Eff, A-CMP, Pump EFF, AC, AHU & Chiller, each with its own record kinds.
3. Then the Power Quality analyser (recordings per audit, quick check otherwise) and Report Studio
   (fill from the audit).

Each app keeps working on its own while this is added: its local data and its Excel export stay
as they are, so nothing a team member does today stops working.
