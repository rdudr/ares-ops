#!/bin/bash
# Off-server backup: copies the newest server backup (database + uploaded files) to this computer,
# then proves it can be restored by unpacking it and opening the database.
#
#   bash deploy/pull-backup.sh                 # host "ar", saves to ~/ares-backups
#   bash deploy/pull-backup.sh ar D:/backups   # other folder (e.g. a synced Google Drive folder)
#
# Keeps the 30 newest copies. Run it daily (see deploy/DEPLOY.md, "Backups").
set -euo pipefail
HOST="${1:-ar}"
DEST="${2:-$HOME/ares-backups}"
mkdir -p "$DEST"
chmod 700 "$DEST" 2>/dev/null || true

# Make sure today's server backup exists, then find the newest one.
ssh "$HOST" 'sudo /etc/cron.daily/ares-backup'
STAMP=$(ssh "$HOST" 'sudo ls -1 /var/backups/ares | sed -n "s/^ares-\(.*\)\.db\.gz$/\1/p" | sort | tail -1')
[ -n "$STAMP" ] || { echo "No backup found on the server." >&2; exit 1; }

OUT="$DEST/ares-$STAMP.tgz"
ssh "$HOST" "sudo tar -czf - -C /var/backups/ares ares-$STAMP.db.gz \$(sudo test -d /var/backups/ares/files-$STAMP && echo files-$STAMP)" > "$OUT.part"
mv "$OUT.part" "$OUT"

# Restore test on a scratch copy.
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
tar -xzf "$OUT" -C "$T"
gunzip "$T/ares-$STAMP.db.gz"
DBPATH="$T/ares-$STAMP.db"
command -v cygpath >/dev/null && DBPATH=$(cygpath -m "$DBPATH")
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
const n = t => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
if (ok !== 'ok') { console.error('Restore test FAILED: ' + ok); process.exit(1); }
console.log('Restore test passed: ' + n('users') + ' people, ' + n('audits') + ' audits, ' + n('records') + ' records, ' + n('files') + ' files.');
" "$DBPATH"
FILES=$(find "$T" -path "*/files-$STAMP/*" -type f | wc -l)
echo "Saved $OUT ($(du -h "$OUT" | cut -f1)), including $FILES uploaded file(s)."

ls -1t "$DEST"/ares-*.tgz 2>/dev/null | tail -n +31 | xargs -r rm -f
