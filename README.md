# ARES Console

Team dashboard, credentials and cloud-sync server for **AR Energy Services**
(planned address: `ops.arenergyservices.in` for the Console, `api.arenergyservices.in` for the apps).
The platform rules live in the website repo: `docs/PLATFORM_RULES.md` (§6a cloud sync, §6b logins, §8 security).

## What it does

- **Overview** — who is working right now, running tasks, and work done by each person: hours
  logged, records collected, records per hour, active days, tasks done on time and overdue. Every
  figure comes from what the apps logged; nothing is estimated.
- **Team & access** — add staff or freelancers, give each one Login ID that works in every app, tick
  the apps they may use, put them on hold, revoke, reset passwords. Changes apply immediately.
- **Audits** — clients and plants (private) with a system-made public industry tag such as
  `TX-SRT-001`; add people to an audit so they see and add data only for that industry.
- **Tasks** — to do / running / done, with due dates and the person responsible.
- **Audit page** — for one audit: what each app has collected (per equipment type), who collected it
  and when, which tasks are still open, and the photos with their captions.
- **Activity log** — every sign-in, change, sync, upload and blocked attempt. It cannot be edited or
  deleted.
- **Sync API** for the field apps (records and work sessions, with fair conflict handling) and the
  **file store** for photos, thermal images, scans and instrument files — see
  [`docs/SYNC_API.md`](docs/SYNC_API.md).
- **Read API** — everything stored for one audit, for Report Studio, the dashboard and the AI services —
  see [`docs/READ_API.md`](docs/READ_API.md) (draft v0).
- **KISEM → AR logic sync kit** — keeps AR apps' formulas in step with the KISEM apps they are based on,
  without mixing the two projects — see [`tools/kisem-logic-sync/`](tools/kisem-logic-sync/README.md).

## Run it

Needs Node.js 22.13 or newer (no other packages).

```bash
npm start
```

Open http://127.0.0.1:8080. On the very first run there are no accounts: the server window prints a
**one-time setup code**. Enter it in the Console to create the Super Admin. There are no default
passwords.

Check everything still works after a change:

```bash
npm test
```

## Settings (environment variables)

| Variable | Default | Use |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `127.0.0.1` | Keep this; put Nginx / the host's proxy in front for HTTPS |
| `DB_FILE` | `data/ares.db` | Database file. Keep it outside any public folder and back it up daily |
| `FILES_DIR` | next to `DB_FILE`, in `files/` | Uploaded photos and files (stored by checksum) |
| `SECURE_COOKIES` | off | Set to `1` on the live server (HTTPS only cookies, HSTS) |
| `TRUST_PROXY` | off | Set to `1` when behind a proxy, so the real visitor IP is logged |

## Security in short

- Passwords hashed with scrypt; login tokens stored only as SHA-256 hashes.
- 5 wrong passwords lock that account **from that address** for 15 minutes (so nobody can lock the real
  owner out from everywhere); 30 failed sign-ins from one address in 10 minutes block that address.
  Admins can **Unlock** a person in the Console; a Super Admin locked out entirely is recovered on the
  server with `scripts/recover-admin.mjs` (see `deploy/DEPLOY.md`).
- Uploaded files are checked against their declared type and checksum, stored outside the web root, and
  only served to managers and people assigned to the audit.
- Console: HTTP-only, SameSite=Strict cookie; signs out after 30 minutes idle or 12 hours.
  Every change request must carry the console's own header and origin (blocks cross-site attacks).
- Apps: bearer token per app and device, valid 7 days, and **re-checked on every call** against the
  person's status, app access and audit assignment — hold, revoke or removing an app takes effect at
  the next call, and the attempt is logged.
- Temporary passwords are shown once; the person must set their own before they can sync.
- Strict Content-Security-Policy, no framing, `noindex`, no third-party scripts.
- The activity log is append-only at database level.

## Before going live

1. Buy the server (VPS) and point `ops.` and `api.` at it — see the platform rules.
2. Run behind HTTPS with `SECURE_COOKIES=1` and `TRUST_PROXY=1`.
3. Set up a daily off-server backup of `data/` and test a restore.
4. Move to PostgreSQL when the team or data grows (the SQL is kept simple for that move).
