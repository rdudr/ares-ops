# KISEM → AR: the routine for every KISEM change (fixes first)

AR's apps, Console and Report Studio were made from KISEM's. So a wrong figure, an error or a security
hole fixed in KISEM is still there in AR until the same fix is brought across. This is the routine that
makes sure it is. Run it whenever something changes in KISEM, and always the same day for a fix.

## 1. See what AR is missing

On the PC that holds both (`Desktop/process`), from `ares-ops`:

```bash
node clients/kisem-port/pending.mjs --fixes
```

It reads KISEM's update ledger (every KISEM commit has a code `KU-YYMMDD-HHMM-APP`) and AR's answer for
each code (`ar-status.json`). It lists what AR has not taken, **fixes first** (wrong figures, errors,
crashes, lost data, security), each with the AR app it belongs to. Without `--fixes` it lists everything.
KISEM-only things are left out by themselves (KISEM website, Inventory WTEA, download page, Excel Team
Data Exchange, KISEM logos).

Tip for KISEM commits: say plainly what was wrong ("flow was π times too high", "approval bypass"). The
list spots fixes by such words.

## 2. Bring each one across, one KISEM commit at a time

| KISEM | AR | Command (from `ares-ops`) |
|---|---|---|
| A field app (A-CMP, MLA, Thermo-X…) | the AR app in `AR Apps/ares-*` | `node clients/kisem-port/replay.mjs <app key> <hash>` |
| FOX Console | ARES Console (`ares-ops`) | `node clients/kisem-port/replay-console.mjs <hash> --except='^docs/\|^test/\|inventory'` |
| PostMan | Report Studio (`report_studio_ares`, branch `report-studio-web`, folder `postman/`) | `node clients/kisem-port/replay-studio.mjs <hash>` |
| AI-PQA | Grid Lens (`ares-power`) | by hand (no replay tool yet) |

App keys for `replay.mjs`: survey (BRIEF), motor (Motor Pulse), heat (Boiler & Fuel), textile (Dye House),
air (Air Findings), pump (Hydro Flow), cool (Cool Zone), xmer (Trafo Check), light (Lux Survey), dryer (Dryer Heat).

Every tool turns KISEM's names into AR's on both sides and merges the change into AR's file
(`git merge-file`). A clash is left in the file as `<<<<<<< AR … ======= … >>>>>>> KISEM`. Settle it before
the next commit (a second merge over a file with clash markers drags KISEM-only code along):

- **AR's names, people, letterhead, look and rules win** (AR Enterprise, AR app names, AR stages
  setup → field → processing → review → approved → published, AR's own Console UI).
- **KISEM's logic wins**: the calculation, the check, the security rule. Write it in AR's names.
- **Never take**: Inventory WTEA (and anything that picks from it), the Excel Team Data Exchange, KISEM's
  Console look, KISEM servers and addresses, KISEM people, IIT Gandhinagar or Kotak wording.
- Two import lines clashing: keep AR's line and add only the new names KISEM's line brings.

Then search the change for KISEM leftovers before committing:

```bash
git diff | grep -E '^\+' | grep -iE 'foxauditiitgn|iitgn|IIT Gandhinagar|KISEM|GridMap|FOX Console|kotak|inventory'
```

## 3. Check it works

- App: `npm run build` (and `npx tsx scripts/calc-check.ts` where the app has its formula check).
- ARES Console: `npm test` (every check must pass). A KISEM fix with no test in AR gets one.
- Report Studio: `npm run build` in `postman/`; after app changes `npm run feeds` with `AR_APPS` set.

## 4. Record it, then push

```bash
node clients/kisem-port/mark.mjs ported "ares-air 980098a" <kisem hash> [...]
node clients/kisem-port/mark.mjs skipped "why" <kisem hash> [...]
node clients/kisem-port/mark.mjs --never
```

Push each AR repo (`main`; Report Studio's `report-studio-web`). A push of `ares-ops` main deploys the
Console after its tests pass; field web apps go out with `deploy/field-web.sh`; Gajendra publishes
Report Studio. Commit `ar-status.json` with the port, so KISEM's ledger shows AR's column.

## Not yet done (20 Nov 2026)

- FOX Console `ab87447`: PaddleOCR bill reader, Torrent PDF bills, IP protection (tripwires that put an
  account on hold), Gmail alerts. Needs decisions: a mail account for AR, AR's own legal / IP policy.
- Grid Lens: seven AI-PQA updates (analyser file readers, THD, upload form from the Console).
- Older FOX Console screens (redesign, overview, app console map): AR keeps its own look; take only logic.
