#!/bin/bash
# Sets up the restricted CI deploy user `ares-ci` on the AR server. Run once by a person with sudo on the
# server (safe to run again, e.g. to change keys). See deploy/DEPLOY.md, "Automatic deploys".
#
#   bash deploy/ci/install.sh ar ~/.ssh/ares_ci_ops.pub                          # key for ares-ops
#   bash deploy/ci/install.sh ar ~/.ssh/ares_ci_ops.pub ~/.ssh/ares_ci_field.pub # and for the field apps
#
# The ops key may deploy ARES (code only), the Console preview and field web apps; the field key only a
# field web app.
# Neither gets a shell: the key's forced command runs /usr/local/sbin/ares-ci-run, the only thing the
# user may run with sudo. This does not touch ~ubuntu/.ssh/authorized_keys: remove the old CI key there
# yourself once the GitHub secrets hold the new keys.
set -euo pipefail
HOST="${1:-ar}"
OPS_PUB="${2:?give the public half of the ops key}"
FIELD_PUB="${3:-}"
cd "$(dirname "$0")/../.."

line() {  # line <pubkey file> <key name>
  local key
  key=$(head -n 1 "$1")
  [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^\"]*)?$ ]] || { echo "!! $1 is not one ed25519 public key" >&2; exit 1; }
  printf 'restrict,command="sudo -n /usr/local/sbin/ares-ci-run --key %s" %s\n' "$2" "$key"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/ci"
{ line "$OPS_PUB" ops; [ -z "$FIELD_PUB" ] || line "$FIELD_PUB" field; } > "$TMP/ci/authorized_keys"
cp deploy/ci/ares-ci-run deploy/ci/sudoers deploy/ar-apps-sync.sh deploy/ar-apps.cron "$TMP/ci/"
tar -czf "$TMP/ci.tgz" -C "$TMP" ci
scp -q "$TMP/ci.tgz" "$HOST:/tmp/ares-ci-setup.tgz"

ssh "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
S=$(mktemp -d)
trap 'rm -rf "$S"; rm -f /tmp/ares-ci-setup.tgz' EXIT
tar -xzf /tmp/ares-ci-setup.tgz -C "$S" --no-same-owner
C="$S/ci"
visudo -cqf "$C/sudoers"

id ares-ci >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/ares-ci --shell /bin/sh ares-ci
passwd -l ares-ci >/dev/null
# Owned by root, so the CI user cannot change its own forced command.
install -d -o root -g root -m 755 /home/ares-ci/.ssh
install -o root -g root -m 644 "$C/authorized_keys" /home/ares-ci/.ssh/authorized_keys

install -o root -g root -m 755 "$C/ares-ci-run" /usr/local/sbin/ares-ci-run
install -d -m 755 /usr/local/lib/ares
install -o root -g root -m 755 "$C/ar-apps-sync.sh" /usr/local/lib/ares/ar-apps-sync.sh
install -o root -g root -m 644 "$C/ar-apps.cron" /etc/cron.d/ar-apps
install -o root -g root -m 440 "$C/sudoers" /etc/sudoers.d/ares-ci
install -d -m 700 /var/lib/ares-ci
touch /var/log/ares-ci.log && chown root:adm /var/log/ares-ci.log && chmod 640 /var/log/ares-ci.log

echo "== ares-ci may run:"
sudo -l -U ares-ci | sed -n '/may run/,$p'
echo "== keys:"
awk '{print "   " $1 " ... " $NF}' /home/ares-ci/.ssh/authorized_keys
REMOTE
echo "== done. Next: put the private keys in the GitHub secrets (AR_DEPLOY_KEY), then remove the old"
echo "   ares-cicd-deploy line from ~ubuntu/.ssh/authorized_keys on the server."
