#!/bin/bash
# Copies this folder straight to the server over SSH (no GitHub involved) and (re)starts the Console.
# GitHub Actions runs the same script with the restricted CI user (deploy/ci/).
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

# The server's installer (deploy/ci/ares-ci-run, set up once with deploy/ci/install.sh) takes the
# tarball on standard input: swap /opt/ares-ops, restart, health check, roll back on failure.
# A person's deploy also installs changed server configuration (unit, Caddyfile, cron, the installer);
# the CI key cannot, so a CI run that changes configuration is refused and this script finishes it.
CONFIG=" --config"
[ -n "${GITHUB_ACTIONS:-}" ] && CONFIG=""
echo "== installing on $HOST"
ssh "$HOST" "sudo -n /usr/local/sbin/ares-ci-run ops $COMMIT$CONFIG" < "$TMP/ares-ops.tgz"
echo "== done: $COMMIT"
