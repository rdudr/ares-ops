# KISEM → AR: AR's side of the update ledger

KISEM names every change with an update code `KU-YYMMDD-HHMM-APP` and lists them in its ledger
(FOX Console `docs/updates/LEDGER.md`, `ledger.json`, made by `tools/updates/updates.mjs`).
`ar-status.json` here is AR's answer for each code, read by that ledger's "AR" column:

| status | meaning |
|---|---|
| `ported` | in AR's `main` (`ar_ref`: AR repo and commit) |
| `pr-open` | in a sync pull request or branch, not merged yet |
| `skipped` | deliberately not taken (`note` says why) |
| `not-applicable` | KISEM-only: KISEM servers, site, people, logo, apps AR does not have |

A code not listed is still pending for AR.

The first version (2026-11-18) was made from AR's git history by `tools/kisem-sync/seed_ar_status.py`
(rules at the top of that file): explicit sync labels in AR commits (`KISEM A-CMP 42e9084`), the shared
kit replay of 16 Nov, everything before each app's `port-app.mjs` run on 3 Nov, Report Studio's copy of
PostMan (16 Nov), and the ares-ops commits that say what they took from FOX Console. From now on the
sync job (one pull request per KISEM release, `clients/kisem-port/replay.mjs`) writes it: `pr-open`
while its pull request is open, `ported` once merged.

App names: A-CMP = Air Findings, Thermo-X = Boiler & Fuel, GridMap = BRIEF, AC, AHU & Chiller =
Cool Zone, Dryers = Dryer Heat, JET-Eff = Dye House, Lighting = Lux Survey, MLA = Motor Pulse,
Pump EFF = Hydro Flow, Xmer-Eff = Trafo Check, AI-PQA = Grid Lens, FOX Console = ARES Console,
PostMan = Report Studio. KISEM's Inventory WTEA, download page and audit website have no AR app.

**The routine for every KISEM change, fixes first: [RUNBOOK.md](RUNBOOK.md)**
(`clients/kisem-port/pending.mjs --fixes` → replay → test → `mark.mjs` → push).
