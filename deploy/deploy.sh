#!/bin/bash
# Copies this folder straight to the server over SSH (no GitHub involved) and (re)starts the Console.
# Test files, the local database and git history are never sent.
#
#   bash deploy/deploy.sh          # uses the "ar" host from ~/.ssh/config
#   bash deploy/deploy.sh myhost   # any other SSH host alias
set -euo pipefail
HOST="${1:-ar}"
cd "$(dirname "$0")/.."

echo "== checking the build"
npm test >/dev/null

echo "== packing"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -czf "$TMP/ares-ops.tgz" --exclude=./.git --exclude=./data --exclude=./test \
  --exclude=./node_modules --exclude=./.claude --exclude=./tools --exclude=./clients --exclude='.env*' --exclude='*.db' --exclude='*.db-*' .

echo "== uploading to $HOST"
scp -q "$TMP/ares-ops.tgz" "$HOST:/tmp/ares-ops.tgz"

echo "== installing on $HOST"
ssh "$HOST" 'set -e
  sudo rm -rf /opt/ares-ops.new
  sudo mkdir -p /opt/ares-ops.new
  sudo tar -xzf /tmp/ares-ops.tgz -C /opt/ares-ops.new
  rm -f /tmp/ares-ops.tgz
  sudo chown -R root:root /opt/ares-ops.new
  sudo rm -rf /opt/ares-ops.old
  if [ -d /opt/ares-ops ]; then sudo mv /opt/ares-ops /opt/ares-ops.old; fi
  sudo mv /opt/ares-ops.new /opt/ares-ops
  if [ -f /etc/systemd/system/ares-ops.service ] && command -v caddy >/dev/null; then
    # Update: refresh config and restart. The database in /var/lib/ares is untouched.
    sudo install -m 644 /opt/ares-ops/deploy/ares-ops.service /etc/systemd/system/ares-ops.service
    sudo install -m 644 /opt/ares-ops/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo install -m 755 /opt/ares-ops/deploy/backup.sh /etc/cron.daily/ares-backup
    # AR apps download page: copy of the APK repo, refreshed every 5 minutes.
    sudo chmod 755 /opt/ares-ops/deploy/ar-apps-sync.sh
    sudo install -m 644 /opt/ares-ops/deploy/ar-apps.cron /etc/cron.d/ar-apps
    sudo /opt/ares-ops/deploy/ar-apps-sync.sh
    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    # validate runs as root and may create new log files: they must stay writable by caddy.
    sudo chown -R caddy:caddy /var/log/caddy
    sudo systemctl daemon-reload
    sudo systemctl restart ares-ops
    sudo systemctl reload caddy
  else
    # First deploy: full setup.
    sudo bash /opt/ares-ops/deploy/setup.sh
  fi
  sleep 2
  echo "service: $(systemctl is-active ares-ops)"
  curl -s -o /dev/null -w "console answers locally: HTTP %{http_code}\n" http://127.0.0.1:8080/'
echo "== done"
