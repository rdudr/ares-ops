# Deploying the ARES Console

The public website stays on Hostinger (`arenergyservices.in`). The Console and the app sync API run on
one Linux server (Oracle Cloud Free Tier or any VPS) under two addresses:

| Address | Serves |
|---|---|
| `arenergyservices.in`, `www.` | Public website (Hostinger, unchanged) |
| `ops.arenergyservices.in` | ARES Console for Super Admins and Head Members |
| `api.arenergyservices.in` | Sync API used by the field apps (`/api/`), and a preview of the Console from the `design-change` branch |

Both names reach the same Node process and database. Only the Console pages differ: on `api.` they
are static files in `/opt/ares-design`, published from the `design-change` branch (see *Console
preview* below). `/api/`, `/apps/`, `/field/` and `/pqa/` behave the same on both names.

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

Then set up the deploy installer and the CI user, which every later deploy goes through:
`bash deploy/ci/install.sh ar ~/.ssh/ares_ci_ops.pub` (see "Automatic deploys" below).

Then open https://ops.arenergyservices.in — the HTTPS certificate is issued automatically on the
first visit once DNS points at the server. Get the one-time setup code with
`sudo journalctl -u ares-ops | grep 'setup code'` and create the Super Admin.

## 4. Updating later

Repeat step 3 — `setup.sh` is safe to run again, and the database in `/var/lib/ares` is never touched
by an update.

### What runs in production

Production runs `main`, and only `main`. Every push to `main` deploys it. `deploy/deploy.sh` refuses
to run from any other branch, from an unpushed commit or from a checkout with changes, because a
deploy from elsewhere replaces what is live and is then undone by the next push. To try a branch, use
the Console preview below. In an emergency, `ALLOW_ANY_BRANCH=1 bash deploy/deploy.sh`, then bring
the same change to `main` straight away. The server records what it runs in
`/opt/ares-ops/DEPLOYED` (commit and time).

### Automatic deploys (GitHub Actions)

Every part on the server has its own pipeline, run on a push to `main`:

| Pipeline | Repo | Deploys | Same as |
|---|---|---|---|
| `Deploy ARES` (`.github/workflows/deploy.yml`) | ares-ops | Console, sync API, Caddyfile, cron jobs | `bash deploy/deploy.sh` |
| (by hand) `bash deploy/site.sh` in the website repo | AR-Enterprise-website-design | The public site arenergyservices.in, files in `/var/www/ar-site` (Caddy block here) | `bash deploy/site.sh` |
| `Deploy Console preview` (`.github/workflows/deploy-design.yml`) | ares-ops, on a push to `design-change` that changes `public/` | Console pages of that branch to `/opt/ares-design` (api.arenergyservices.in); no restart, no data | `bash deploy/deploy-design.sh` |
| (by hand) `bash deploy/billing.sh` | ares-ops | GST Billing (installs a service, so never from CI) | |
| `Web app` (`.github/workflows/field-web.yml`, from the AR app kit) | each field app repo | that app at `/field/<app>/` | `bash deploy/field-web.sh <app>` |
| `Android APK` (`.github/workflows/android-apk.yml`, from the AR app kit) | each field app repo | signed APK to the download page | `node scripts/android-apk.mjs` |

ARES and the web apps are health-checked after the swap; if they don't answer, the previous version
is put back (the failed one stays in `<folder>.failed`) and the run fails.

**The CI user cannot take root.** Pipelines log in as `ares-ci`, which has no shell: each SSH key is
bound to a forced command, `sudo -n /usr/local/sbin/ares-ci-run --key ops|field`, and that installer is
all the user may run with sudo (`deploy/ci/sudoers`). The tarball comes on standard input. The `ops` key
may deploy ARES and the Console preview, the `field` key only a field web app. CI never installs server
configuration (the systemd unit, the Caddyfile, cron jobs, the installer itself, the sudoers rule): a
push that changes one of them is refused by CI before anything is touched ("this deploy changes server
configuration"), and a person finishes it with `bash deploy/deploy.sh` from a clean `main`, which
validates and installs it. A leaked CI key can therefore replace the Console's code (which runs as the
`ares` user), not the server. Packages are installed with `--ignore-scripts`. Every run is logged in
`/var/log/ares-ci.log`. The cron job runs the installed `/usr/local/lib/ares/ar-apps-sync.sh`, never a
file from a deploy.

Setting it up (once; again to change keys):

```bash
ssh-keygen -t ed25519 -N '' -C ares-ci-ops   -f ~/.ssh/ares_ci_ops
ssh-keygen -t ed25519 -N '' -C ares-ci-field -f ~/.ssh/ares_ci_field     # when field repos get CI
bash deploy/ci/install.sh ar ~/.ssh/ares_ci_ops.pub ~/.ssh/ares_ci_field.pub
```

Then put each private key in its repos' `AR_DEPLOY_KEY` secret and remove the old `ares-cicd-deploy`
line from `~ubuntu/.ssh/authorized_keys` on the server.

Secrets in every repo that deploys (Settings → Secrets and variables → Actions):

- `AR_DEPLOY_KEY`: the private half of the `ops` key (ares-ops) or the `field` key (field app repos),
  ed25519. The public halves are in `~ares-ci/.ssh/authorized_keys` on the server.
- `AR_KNOWN_HOSTS`: the server's host key, `ssh-keyscan -t ed25519 130.210.60.79` (fingerprint
  `SHA256:/oe/CDTYOmtvNeiAI174EG1Nl3/YgeAM52HQe4M9UTs`; check it before saving).
- Optional variable `AR_HOST` if the address changes.

To pause automatic deploys, disable the workflow in the repo's Actions tab. Manual deploys with the
scripts keep working (they go through the same installer with your own login). To revoke a key, remove
its line from `~ares-ci/.ssh/authorized_keys`.

### Console preview (api.arenergyservices.in)

The redesign is built on the `design-change` branch. Each push publishes that branch's `public/`
folder to `/opt/ares-design`, which Caddy serves at `https://api.arenergyservices.in` with the same
security headers as the Node server. Its pages call the same `/api/` as the Console on `ops.`, so a
change made in the preview is a real change. The sign-in is separate (the cookie belongs to each
name). Server changes (`lib/`, `server.js`) on the branch do **not** reach the preview: they go live
only when merged into `main`.

## Report Studio connector (mcp.arenergyservices.in)

Add an A record `mcp` pointing at the server, as for `ops` and `api`. Caddy gets the certificate once it
resolves. The connector is a separate repo (`report_studio_ares`), installed with its own
`deploy/deploy-ar.sh`: service `report-studio` on `127.0.0.1:8790`, data in `/var/lib/report-studio`.
It serves demo audits and real audits while their AI access is on; ARES enforces the same on its side.
Drafts come back to the audit's page for review (`docs/REPORT_DRAFT.md`). For the Console's "Print"
button, set `REPORT_CONNECTOR_URL=http://127.0.0.1:8790` and `REPORT_CONNECTOR_KEY` here, and the same
key as `RS_INTERNAL_KEY` in the connector's `/etc/report-studio/internal.env`; without them the button
is hidden. The older `/mcp` connector answers 410 unless `MCP_CONNECTOR=on`.

## Report Studio (ops.arenergyservices.in/report/)

The report editor (repo `report_studio_ares`, folder `postman/`), opened from an audit's page with "Open in
Report Studio" (`lib/apps.js`, app `report`). One static page in `/opt/ar-report`, served by Caddy at
`/report/` on both names (`Caddyfile`, `ares_common`); published with `bash deploy/deploy-studio.sh` in that
repo. No service and no restart: the route arrives with an ARES deploy, the page with its own.

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

It downloads the newest backup (database, uploaded files, GST Billing's data) and runs a **restore
test** each time: it unpacks the copy and opens the database ("Restore test passed: … people, … audits,
… records, … files"). It runs every night on the workstation `mangora` (a separate VM), from its crontab:

```
30 21 * * * cd /home/ubuntu/ar-energy/ares-ops && bash deploy/pull-backup.sh ar /home/ubuntu/ares-backups >> /home/ubuntu/ares-backups/pull.log 2>&1
```

Both VMs are in the same Oracle account and region (Mumbai), so this protects against losing the server,
not against losing the account: keep a second copy elsewhere too (a Google Drive folder on a laptop), for
example with Windows Task Scheduler:

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
