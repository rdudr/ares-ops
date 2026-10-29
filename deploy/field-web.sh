#!/bin/bash
# Builds the field apps as web apps (PWAs) and puts them on the AR server under
# https://ops.arenergyservices.in/field/<app>/. Same screens and ARES login as the Android apps;
# the Console's App console opens them.
#
#   bash deploy/field-web.sh            # all apps
#   bash deploy/field-web.sh brief mla  # some
set -euo pipefail
HOST="${HOST:-ar}"
APPS_DIR="$(cd "$(dirname "$0")/../../AR Apps" && pwd)"
# web path : app folder
ALL="brief:ares-brief jet:ares-jet pump:ares-pump air:ares-air boiler:ares-boiler cooling:ares-cooling mla:ares-mla"
WANT="${*:-}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for pair in $ALL; do
  slug="${pair%%:*}"; dir="${pair#*:}"
  if [ -n "$WANT" ] && [[ " $WANT " != *" $slug "* ]]; then continue; fi
  echo "== building $slug"
  (cd "$APPS_DIR/$dir" && rm -rf out && node scripts/web-build.mjs --base "field/$slug" | tail -1)
  tar -czf "$TMP/$slug.tgz" -C "$APPS_DIR/$dir/out" .
  scp -q "$TMP/$slug.tgz" "$HOST:/tmp/field-$slug.tgz"
  ssh "$HOST" "set -e
    sudo install -d /opt/ar-field
    sudo rm -rf /opt/ar-field/$slug.new && sudo mkdir -p /opt/ar-field/$slug.new
    sudo tar -xzf /tmp/field-$slug.tgz -C /opt/ar-field/$slug.new && rm -f /tmp/field-$slug.tgz
    sudo chmod -R a+rX /opt/ar-field/$slug.new
    sudo rm -rf /opt/ar-field/$slug.old
    if [ -d /opt/ar-field/$slug ]; then sudo mv /opt/ar-field/$slug /opt/ar-field/$slug.old; fi
    sudo mv /opt/ar-field/$slug.new /opt/ar-field/$slug"
  echo "   live: https://ops.arenergyservices.in/field/$slug/"
done
echo "== done"
