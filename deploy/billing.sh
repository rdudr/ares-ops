#!/bin/bash
# Installs or updates GST Billing (Free GST Billing Software, MIT) on the AR server:
# https://billing.arenergyservices.in, behind the ARES sign-in (lib/routes-billing.js, Caddyfile).
# The data (data/, Saved Invoices/, Trash/) is never touched by an update.
#
#   bash deploy/billing.sh            # the tested version below
#   bash deploy/billing.sh <commit>   # another upstream commit or tag (check its changes first)
set -euo pipefail
HOST="${HOST:-ar}"
REPO=https://github.com/IamRamgarhia/Free-GST-Billing-Software.git
REF="${1:-c40309e}"   # v1.10.82, 2026-10-30
HERE="$(cd "$(dirname "$0")" && pwd)"

scp -q "$HERE/gst-billing.service" "$HOST:/tmp/gst-billing.service"
ssh "$HOST" "REPO='$REPO' REF='$REF' bash -s" <<'REMOTE'
set -euo pipefail
id gstbill >/dev/null 2>&1 || sudo useradd --system --home-dir /opt/gst-billing --shell /usr/sbin/nologin gstbill
sudo install -d -o gstbill -g gstbill -m 750 /opt/gst-billing
as() { sudo -u gstbill -H env HOME=/opt/gst-billing/home PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bash -c "cd /opt/gst-billing && $1"; }
as 'mkdir -p home'
if [ ! -d /opt/gst-billing/.git ]; then
  as "git init -q && git remote add origin '$REPO'"
fi
as "git fetch -q --depth 50 origin main && git checkout -q --force '$REF' 2>/dev/null || (git fetch -q origin '$REF' && git checkout -q --force FETCH_HEAD)"
# The desktop update/restore/move scripts must never run on the server.
as 'rm -rf release-templates/_system-scripts _system-scripts'
echo "== building $(as 'git log -1 --format="%h %s"' | cut -c1-80)"
as 'npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build --silent >/dev/null'
as 'rm -f dist/sw.js dist/registerSW.js dist/workbox-*.js'
sudo install -m 644 /tmp/gst-billing.service /etc/systemd/system/gst-billing.service && rm -f /tmp/gst-billing.service
sudo systemctl daemon-reload
sudo systemctl enable -q gst-billing
sudo systemctl restart gst-billing
for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:47371/api/health && break; sleep 1; done
curl -fsS http://127.0.0.1:47371/api/health && echo
REMOTE
echo "== GST Billing: https://billing.arenergyservices.in (Caddy config comes with: bash deploy/deploy.sh)"
