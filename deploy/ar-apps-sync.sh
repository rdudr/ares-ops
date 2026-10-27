#!/bin/bash
# Keeps /var/www/ar-apps equal to the public APK repo on GitHub, so the download page and APKs are
# served from this server at https://ops.arenergyservices.in/apps/. Run by /etc/cron.d/ar-apps every
# 5 minutes: a release pushed to GitHub is live here within minutes, with no keys stored in CI.
set -euo pipefail
REPO=https://github.com/rdudr/AR-Enterprise-APPS-Repo-.git
DIR=/var/www/ar-apps
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone -q --depth 1 "$REPO" "$DIR"
else
  git -C "$DIR" fetch -q --depth 1 origin main
  git -C "$DIR" reset -q --hard origin/main
  git -C "$DIR" clean -qfdx
fi
chmod -R a+rX "$DIR"
