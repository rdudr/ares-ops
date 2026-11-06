#!/bin/bash
# Copies this folder straight to the server over SSH (no GitHub involved) and (re)starts the Console.
# Test files, the local database and git history are never sent.
#
#   bash deploy/deploy.sh          # uses the "ar" host from ~/.ssh/config
#   bash deploy/deploy.sh myhost   # any other SSH host alias
set -euo pipefail
HOST="${1:-ar}"
cd "$(dirname "$0")/.."

# Production runs main, and only main. A deploy from another branch or an unpushed checkout replaces
# whatever is live and is undone by the next push. GitHub Actions deploys the pushed commit itself.
if [ -z "${GITHUB_ACTIONS:-}" ] && [ "${ALLOW_ANY_BRANCH:-}" != "1" ]; then
  git fetch -q origin main
  if [ "$(git rev-parse --abbrev-ref HEAD)" != main ] || [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ -n "$(git status --porcelain)" ]; then
    echo "!! refusing to deploy: use a clean checkout of main, level with origin/main."
    echo "   To try a branch, use deploy/deploy-design.sh (Console pages only, on api.arenergyservices.in)."
    echo "   For an emergency: ALLOW_ANY_BRANCH=1 bash deploy/deploy.sh"
    exit 1
  fi
fi
COMMIT=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)

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
ssh "$HOST" "COMMIT=$COMMIT; "'set -e
  sudo rm -rf /opt/ares-ops.new
  sudo mkdir -p /opt/ares-ops.new
  sudo tar -xzf /tmp/ares-ops.tgz -C /opt/ares-ops.new
  rm -f /tmp/ares-ops.tgz
  sudo chown -R root:root /opt/ares-ops.new
  # Packages (one: the Anthropic SDK for the optional AI bill reader), installed before the swap so a
  # failed install leaves the running version alone.
  ( cd /opt/ares-ops.new && sudo npm ci --omit=dev --no-audit --no-fund --loglevel=error )
  echo "$COMMIT $(date -u +%FT%TZ)" | sudo tee /opt/ares-ops.new/DEPLOYED >/dev/null
  sudo rm -rf /opt/ares-ops.old
  if [ -d /opt/ares-ops ]; then sudo mv /opt/ares-ops /opt/ares-ops.old; fi
  sudo mv /opt/ares-ops.new /opt/ares-ops
  # A copy of the database before the new code starts (it may add columns or tables).
  if sudo test -f /var/lib/ares/ares.db; then
    sudo install -d -m 700 /var/backups/ares
    sudo sqlite3 /var/lib/ares/ares.db ".backup /var/backups/ares/pre-deploy-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null \
      || sudo cp /var/lib/ares/ares.db "/var/backups/ares/pre-deploy-$(date +%Y%m%d-%H%M%S).db"
  fi
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
  # The Console must answer within 20 s; otherwise put the previous version back.
  code=000
  for i in $(seq 1 10); do
    sleep 2
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/ || true)
    if [ "$code" = 200 ]; then break; fi
  done
  echo "service: $(systemctl is-active ares-ops), console answers locally: HTTP $code"
  if [ "$code" != 200 ] && [ -d /opt/ares-ops.old ]; then
    echo "!! health check failed: putting the previous version back"
    sudo rm -rf /opt/ares-ops.failed
    sudo mv /opt/ares-ops /opt/ares-ops.failed
    sudo mv /opt/ares-ops.old /opt/ares-ops
    sudo install -m 644 /opt/ares-ops/deploy/ares-ops.service /etc/systemd/system/ares-ops.service
    sudo install -m 644 /opt/ares-ops/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo systemctl daemon-reload
    sudo systemctl restart ares-ops
    sudo systemctl reload caddy
    echo "!! rolled back; the failed version is in /opt/ares-ops.failed"
    exit 1
  fi
  [ "$code" = 200 ]'
echo "== done: $COMMIT"
