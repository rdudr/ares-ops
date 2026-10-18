#!/bin/bash
# One-time server setup for the ARES Console on Ubuntu/Debian. Run as root:
#   bash /opt/ares-ops/deploy/setup.sh
# Safe to run again: each step checks what is already there.
set -euo pipefail

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

echo "== Node.js 24"
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
node --version

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== service user and folders"
id ares >/dev/null 2>&1 || useradd --system --home /var/lib/ares --shell /usr/sbin/nologin ares
install -d -o ares -g ares -m 700 /var/lib/ares
install -d -m 700 /var/backups/ares
chown -R root:root /opt/ares-ops
chmod -R go-w /opt/ares-ops

echo "== systemd service"
install -m 644 /opt/ares-ops/deploy/ares-ops.service /etc/systemd/system/ares-ops.service
systemctl daemon-reload
systemctl enable ares-ops
systemctl restart ares-ops

echo "== Caddy site"
install -d -o caddy -g caddy /var/log/caddy
install -m 644 /opt/ares-ops/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "== daily backup"
install -m 755 /opt/ares-ops/deploy/backup.sh /etc/cron.daily/ares-backup

echo "== firewall: only SSH and web"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

sleep 2
systemctl --no-pager --lines=0 status ares-ops | head -5
echo
echo "Done. If this is the first run, the one-time setup code is in:"
echo "  journalctl -u ares-ops | grep 'setup code'"
