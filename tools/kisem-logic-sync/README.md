# KISEM → AR logic sync

The AR Enterprise field apps reuse the **formulas, calculation steps and graph logic** of the KISEM
apps, but have their own names, logos and interface. AR Enterprise and KISEM stay separate projects:
this kit never changes an AR app or a KISEM app on its own. It makes sure that when a formula changes
in KISEM, the AR side **knows about it and gets a ready-to-review update**.

## How it works

```
KISEM repo (push to main)                      AR app repo
  ar-logic.json  ── lists the logic files        kisem-logic.lock.json ── which KISEM commit AR matches
  .github/workflows/ar-logic-notify.yml          .github/workflows/kisem-logic-sync.yml
        │ a listed file changed                   scripts/kisem-sync.mjs
        └──── "logic changed" ───────────────▶   opens a pull request:
                                                   • calculation files copied, byte-for-byte
                                                   • checklist of pages / graphs to port by hand
```

Two kinds of files:

- **copy** — pure calculation files (e.g. `lib/pump-calc.ts`, `lib/steam-table.ts`). They contain no
  names or branding, so the AR app uses them unchanged from `vendor/kisem/<app>/…`. They can never
  drift from KISEM.
- **watch** — pages, charts and the store, where logic sits inside the KISEM interface. The AR app has
  its own interface, so these cannot be copied; a change produces a checklist item with a link so
  someone ports it by hand.

Even without any token, the AR repo checks every day at 09:00 IST, so nothing is missed.

## Set up (once per app)

**In the KISEM app repo** (you add these yourself):

1. Copy `kisem-side/manifests/<app>.ar-logic.json` to the repo root as **`ar-logic.json`**. Put the AR
   app's repo name in `notify` once it exists.
2. Copy `kisem-side/ar-logic-notify.yml` to **`.github/workflows/ar-logic-notify.yml`**.
3. Optional, for instant notification: add a secret **`AR_SYNC_TOKEN`** (Settings → Secrets → Actions):
   a fine-grained GitHub token with *Contents: read and write* on the AR app repo. Without it, the
   change still shows in the KISEM Actions run summary and the AR repo's daily check picks it up.

**In the AR app repo:**

1. Copy `ar-side/locks/<app>.kisem-logic.lock.json` to the repo root as **`kisem-logic.lock.json`**.
2. Copy `ar-side/kisem-sync.mjs` to **`scripts/kisem-sync.mjs`**.
3. Copy `ar-side/kisem-logic-sync.yml` to **`.github/workflows/kisem-logic-sync.yml`**.
4. If the KISEM repo is private, add a secret **`KISEM_READ_TOKEN`**: a fine-grained token with
   *Contents: read* on that KISEM repo.
5. Settings → Actions → General → tick **Allow GitHub Actions to create and approve pull requests**.
6. Run it once (Actions → KISEM logic sync → Run workflow) to copy the current files.

## Day to day

- KISEM changes a formula and pushes → a pull request appears in the AR app: "KISEM logic update".
- Check the changes, port anything on the checklist, run the AR app's tests, merge.
- To see what is pending at any time on a computer: `node scripts/kisem-sync.mjs --check`.

## Files here

| File | Goes where |
|---|---|
| `kisem-side/manifests/<app>.ar-logic.json` | KISEM repo root, as `ar-logic.json` |
| `kisem-side/ar-logic-notify.yml` | KISEM repo, `.github/workflows/` |
| `ar-side/locks/<app>.kisem-logic.lock.json` | AR app repo root, as `kisem-logic.lock.json` |
| `ar-side/kisem-sync.mjs` | AR app repo, `scripts/` |
| `ar-side/kisem-logic-sync.yml` | AR app repo, `.github/workflows/` |

Ready-made manifests: fox-kisem, Jet-EFF, A-CMP, Thermo-X, pump-Up, Zero-Degree, AI-PQA.
