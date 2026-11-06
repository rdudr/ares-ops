# Energy Ledger

A menu in the ARES Console (Manage > Energy Ledger), not a separate app. Super Admins have it, and Admins it is given to in Team & access (app code `ledger`, separate from GST Billing, `bills`), on the audits they may see. For each company it holds the
electricity bills, the energy and water baseline, and the GHG inputs. Open it from the menu or from
the company's page; "Enter data" opens it in its own window.

## Where things are

| What | Where |
|---|---|
| Screens | `public/ledger.js` |
| All the arithmetic | `public/ledger-calc.js` (screens, report, Excel and tests all use it) |
| Reading bills | `public/ledger-ocr.js`, with pdf.js and tesseract.js in `public/vendor/ocr` |
| DEFRA factors | `public/ledger-factors.json`, made by `tools/build-ghg-factors.py` |
| Saving, company data | `lib/routes-ledger.js` |
| CEA versions and the daily check | `lib/cea.js` |

Data: one record per company per part, app `ledger`, kinds `ledger_bills`, `ledger_baseline`,
`ledger_ghg`, ids `led-bills-<audit>` and so on. They are versioned like every record, and a page
that is out of date is refused rather than overwriting a team-mate. Bill pictures are Console files
(app `ledger`, kind `scan`, tag = the month).

## Bill format

The bill table in the report and the Excel download is the team's "bills analysis" workbook, the
same 33 columns, headings, Total and Average rows (`BILL_SHEET` in `public/ledger.js`).

The demand charge has an above-contract rate: slabs up to the contract, then the excess kVA at
Rs 555 on HTP-1. Without it the workbook does not balance. The test uses invented figures.

TOU discount: the rupee figure printed on the bill if there is one, else TOU DISC Unit x Rate Per KVA.
Either way it comes off once, whatever sign the bill prints it with.

Excel dates are read as serial numbers: as Date objects they can land a month early.

## CEA CDM-CO2 Baseline Database: keeping up with new versions

**The version is always stated.** Every grid factor shows its version, publication month, financial
year and basis, on screen, in the report and in Excel: "CEA CO2 Baseline Database Version
22.0 (August 2026), FY 2025-26, weighted average". Each company keeps the version it was worked out
with, so a finished report never changes by itself.

**How we find out about a new version.** Once a day the server reads the public CEA page
(https://cea.nic.in/cdm-co2-baseline-view?mappingId=234&lang=en) and compares the highest "Version N.N"
with the newest one held. "Check CEA now" on the Energy Ledger page does the same at any time. A newer
number puts a notice on the Energy Ledger page, each company's Ledger and the Console Overview, and one
line in the activity log. If the check fails, the page says so and when: silence never means "up to date".

**What to do when the notice appears (Super Admin):**

1. Open the CEA page from the notice and download the new User Guide.
2. Energy Ledger > CEA baseline > Add the new version.
3. Type Appendix C: Table B (with cross-border transfers) and Table A (without), for the new year and
   for any earlier year the guide revised. Years left out are carried over from the previous version.
4. Save. The notice goes, the new version is offered to every company, and each company's Ledger shows
   "Move to Version N". Moving is a person's choice, company by company.

The numbers are typed, not fetched, on purpose: CEA publishes them in a PDF and a workbook whose layout
changes, and a misread grid factor would quietly change every report.

A financial year CEA has not published yet uses the newest year it has, and says so on screen and in
the report. CEA factors are tCO2/MWh, CO2 only, not CO2e.

## DEFRA factors: the yearly update

New set each June (the sheets give the date). Run
`python tools/build-ghg-factors.py <full-set.xlsx> public/ledger-factors.json`, update the spot values in
`test/smoke.mjs`, and commit. The set is UK-based: DEFRA's factor per tonne of coal assumes UK coal, so the
Ledger offers the per-heat figure when the plant's GCV is far from it. Vehicles, freight and rail are wide
grids that are not read; a custom line takes any factor with its source.

## Security

Bills stay on the Console: the readers are served from it, nothing comes from a CDN. Only the files in
`/vendor/ocr/` may run WebAssembly; the Console page itself keeps its strict policy. AI reading of a bill
stays off until the server is set up for it, needs the client's consent each time the page is opened,
fills only empty fields, and every figure still needs a person to verify it.

## The report

Report tab, "Print or save as PDF". A4 portrait with the AR name, company and page numbers on every
page (the `@page` rules in `public/styles.css`; these need Chrome or Edge 131 or later, older
browsers print without the page margins). Page one is the AR heading, key figures, findings and data
sources. Then three parts, each with all its tables and graphs: 1 Electricity bills, 2 Energy baseline,
3 GHG emissions. Only the team's 33-column bill table takes a wide A3 page of its own (`@page billsheet`).

## In AR

Report Studio for AR is not built yet, so nothing reads the Ledger into a report there; the Ledger's own report and Excel work.
