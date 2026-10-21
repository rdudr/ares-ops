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

Domains → arenergyservices.in → **DNS records** → add two **A** records to the server's public IP:
`ops` and `api`. Do not change the nameservers or the existing website records.

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

## Backups

`/etc/cron.daily/ares-backup` keeps 14 daily copies in `/var/backups/ares`. Also copy them **off the
server** regularly (a free-tier server can be reclaimed).
