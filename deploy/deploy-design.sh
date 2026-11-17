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

echo "== installing on $HOST"
# The server's installer (deploy/ci/ares-ci-run): swap /opt/ares-design, check, put the old pages back on failure.
ssh "$HOST" "sudo -n /usr/local/sbin/ares-ci-run design" < "$TMP/ares-design.tgz"
echo "== done: https://api.arenergyservices.in"
