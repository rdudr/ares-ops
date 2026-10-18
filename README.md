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
- **Activity log** — every sign-in, change, sync and blocked attempt. It cannot be edited or deleted.
- **Sync API** for the field apps — see [`docs/SYNC_API.md`](docs/SYNC_API.md).

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
| `SECURE_COOKIES` | off | Set to `1` on the live server (HTTPS only cookies, HSTS) |
| `TRUST_PROXY` | off | Set to `1` when behind a proxy, so the real visitor IP is logged |

## Security in short

- Passwords hashed with scrypt; login tokens stored only as SHA-256 hashes.
- 5 wrong passwords lock the account for 15 minutes; sign-in attempts are rate-limited per IP.
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
