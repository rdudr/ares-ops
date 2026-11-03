#!/bin/bash
# Publishes the Console pages of this checkout (public/) to the preview at
# https://api.arenergyservices.in (folder /opt/ares-design on the server, see deploy/Caddyfile).
# Only the static pages: the preview talks to the same ARES server and database as
# ops.arenergyservices.in, so nothing here restarts a service or touches data.
# Run by .github/workflows/deploy-design.yml on every push to the design-change branch.
#
#   bash deploy/deploy-design.sh          # uses the "ar" host from ~/.ssh/config
#   bash deploy/deploy-design.sh myhost   # any other SSH host alias
set -euo pipefail
HOST="${1:-ar}"
cd "$(dirname "$0")/.."

echo "== checking the build"
npm test >/dev/null

echo "== packing public/"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -czf "$TMP/ares-design.tgz" -C public .

echo "== uploading to $HOST"
scp -q "$TMP/ares-design.tgz" "$HOST:/tmp/ares-design.tgz"

echo "== installing on $HOST"
ssh "$HOST" 'set -e
  sudo rm -rf /opt/ares-design.new
  sudo mkdir -p /opt/ares-design.new
  sudo tar -xzf /tmp/ares-design.tgz -C /opt/ares-design.new
  rm -f /tmp/ares-design.tgz
  sudo chown -R root:root /opt/ares-design.new
  sudo chmod -R u=rwX,go=rX /opt/ares-design.new
  sudo rm -rf /opt/ares-design.old
  if [ -d /opt/ares-design ]; then sudo mv /opt/ares-design /opt/ares-design.old; fi
  sudo mv /opt/ares-design.new /opt/ares-design
  code=$(curl -s -o /dev/null -w "%{http_code}" --resolve api.arenergyservices.in:443:127.0.0.1 https://api.arenergyservices.in/ || true)
  echo "preview answers: HTTP $code"
  if [ "$code" != 200 ] && [ -d /opt/ares-design.old ]; then
    sudo rm -rf /opt/ares-design && sudo mv /opt/ares-design.old /opt/ares-design
    echo "preview did not answer: previous pages put back"
    exit 1
  fi'
echo "== done: https://api.arenergyservices.in"
