# Deploying the ARES Console

The public website stays on Hostinger (`arenergyservices.in`). The Console and the app sync API run on
one Linux server (Oracle Cloud Free Tier or any VPS) under two addresses:

| Address | Serves |
|---|---|
| `arenergyservices.in`, `www.` | Public website (Hostinger, unchanged) |
| `ops.arenergyservices.in` | ARES Console for Super Admins and Head Members |
| `api.arenergyservices.in` | Sync API used by the field apps |

## 1. Create the server (Oracle Cloud Free Tier)

1. Sign up at oracle.com/cloud/free. Pick **India West (Mumbai)** or **India South (Hyderabad)** as the
   home region — free Arm servers can only be created there, and it cannot be changed later.
2. Compute → Instances → **Create instance**
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **Ampere A1** (Arm), 1–2 OCPU, 6–12 GB memory. If it says "out of capacity", try again later
     or use **VM.Standard.E2.1.Micro** (also free; enough for a small team).
   - Networking: create a new VCN with a public subnet; **Assign a public IPv4 address**.
   - SSH keys: **Paste public keys** → paste `ares-ops-deploy` key (see below).
3. After it starts: instance → Attached VNICs → IPv4 addresses → make the public IP **Reserved**
   so it never changes.
4. Networking → Virtual cloud networks → your VCN → Security lists → Default → **Add ingress rules**:
   source `0.0.0.0/0`, TCP, destination ports `80` and `443`.

## 2. Point the addresses (Hostinger hPanel)

Domains → arenergyservices.in → **DNS records** → add **A** records to the server's public IP:
`ops`, `api` and `billing` (GST Billing). Do not change the nameservers or the existing website records.

## 3. Install

From a computer that has the deploy key:

```bash
tar -czf ares-ops.tgz --exclude=data --exclude=.git .
scp -i ~/.ssh/ares_vps_ed25519 ares-ops.tgz ubuntu@SERVER_IP:/tmp/
ssh -i ~/.ssh/ares_vps_ed25519 ubuntu@SERVER_IP \
  'sudo mkdir -p /opt/ares-ops && sudo tar -xzf /tmp/ares-ops.tgz -C /opt/ares-ops && sudo bash /opt/ares-ops/deploy/setup.sh'
```

(On Oracle the user is `ubuntu`; on a Hostinger VPS it is `root`, without `sudo`.)

Then open https://ops.arenergyservices.in — the HTTPS certificate is issued automatically on the
first visit once DNS points at the server. Get the one-time setup code with
`sudo journalctl -u ares-ops | grep 'setup code'` and create the Super Admin.

## 4. Updating later

Repeat step 3 — `setup.sh` is safe to run again, and the database in `/var/lib/ares` is never touched
by an update.

### Automatic deploys (GitHub Actions)

Every part on the server has its own pipeline, run on a push to `main`:

| Pipeline | Repo | Deploys | Same as |
|---|---|---|---|
| `Deploy ARES` (`.github/workflows/deploy.yml`) | ares-ops | Console, sync API, Caddyfile, cron jobs | `bash deploy/deploy.sh` |
| `Deploy GST Billing` (`.github/workflows/deploy-billing.yml`) | ares-ops, only when `billing.sh` or `gst-billing.service` change; or run by hand with another upstream commit | GST Billing | `bash deploy/billing.sh` |
| `Web app` (`.github/workflows/field-web.yml`, from the AR app kit) | each field app repo | that app at `/field/<app>/` | `bash deploy/field-web.sh <app>` |
| `Android APK` (`.github/workflows/android-apk.yml`, from the AR app kit) | each field app repo | signed APK to the download page | `node scripts/android-apk.mjs` |

ARES and the web apps are health-checked after the swap; if they don't answer, the previous version
is put back (the failed one stays in `<folder>.failed`) and the run fails.

Secrets, the same in every repo that deploys (Settings → Secrets and variables → Actions):

- `AR_DEPLOY_KEY`: the private half of the CI key `ares-cicd-deploy` (ed25519). Its public half is in
  `~ubuntu/.ssh/authorized_keys` on the server, with port, agent and X11 forwarding switched off.
- `AR_KNOWN_HOSTS`: the server's host key, `ssh-keyscan -t ed25519 130.210.60.79` (fingerprint
  `SHA256:/oe/CDTYOmtvNeiAI174EG1Nl3/YgeAM52HQe4M9UTs`; check it before saving).
- Optional variable `AR_HOST` if the address changes.

To pause automatic deploys, disable the workflow in the repo's Actions tab. Manual deploys with the
scripts keep working. To revoke the key, remove its line from `~ubuntu/.ssh/authorized_keys`.

## GST Billing (billing.arenergyservices.in)

The open-source Free GST Billing Software (MIT, github.com/IamRamgarhia/Free-GST-Billing-Software),
installed and updated with `bash deploy/billing.sh` (a tested upstream commit; pass another commit to
move on, after reading its changes). It runs as the `gst-billing` service (user `gstbill`, only
`/opt/gst-billing` writable) on 127.0.0.1:47371. Caddy checks every request with ARES first
(`lib/routes-billing.js`): only Super Admins and Heads signed in to the Console get in, through a
one-time code that gives the billing site its own session. The app's desktop parts (update, restore
and move scripts, opening folders) and its offline service worker are switched off. Its data
(`data/`, `Saved Invoices/`) is in the daily backup as `billing-<date>.tar.gz`.

## Backups

**On the server:** `/etc/cron.daily/ares-backup` keeps 14 daily copies of the database (checked with
SQLite's integrity check) and of the uploaded files (hard-link snapshots, so unchanged files take no
extra space) in `/var/backups/ares`.

**Off the server** (a free-tier server can be reclaimed — this is the copy that matters):

```bash
bash deploy/pull-backup.sh                  # saves to ~/ares-backups, keeps 30
bash deploy/pull-backup.sh ar "G:/My Drive/ARES backups"   # or into a Google Drive folder
```

It downloads the newest backup and runs a **restore test** each time: it unpacks the copy and opens the
database ("Restore test passed: … people, … audits, … records, … files"). Run it daily, for example
with Windows Task Scheduler:

```
schtasks /Create /SC DAILY /ST 21:00 /TN "ARES backup" /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc 'cd /c/Users/risha/Desktop/process/ares-ops && bash deploy/pull-backup.sh'"
```

**Restoring:** stop the service, put the backup database in place, put the files back, start it:

```bash
ssh ar 'sudo systemctl stop ares-ops'
# copy ares-<date>.db (gunzipped) to /var/lib/ares/ares.db and files-<date>/ to /var/lib/ares/files/
ssh ar 'sudo chown -R ares:ares /var/lib/ares && sudo systemctl start ares-ops'
```

## Super Admin locked out

Run on the server (only possible with the SSH key):

```bash
ssh ar 'sudo -u ares DB_FILE=/var/lib/ares/ares.db node /opt/ares-ops/scripts/recover-admin.mjs <login_id> && sudo systemctl restart ares-ops'
```

It prints a one-time password, reactivates the account and ends its sessions.
