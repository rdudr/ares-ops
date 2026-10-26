#!/bin/sh
# Daily backup of the ARES database and uploaded files, kept for 14 days on this server.
# Runs from /etc/cron.daily. Off-server copies: see deploy/DEPLOY.md ("Backups").
set -eu
DATA=/var/lib/ares
DEST=/var/backups/ares
STAMP=$(date +%Y-%m-%d)
mkdir -p "$DEST"
chmod 700 "$DEST"

# Database: a consistent copy even while the service is writing, then checked.
if [ -f "$DATA/ares.db" ]; then
  sqlite3 "$DATA/ares.db" ".backup '$DEST/ares-$STAMP.db'"
  [ "$(sqlite3 "$DEST/ares-$STAMP.db" 'PRAGMA integrity_check;')" = "ok" ] || { echo "backup integrity check failed" >&2; exit 1; }
  gzip -f "$DEST/ares-$STAMP.db"
fi

# Files are stored by checksum and never change, so each day is a hard-link snapshot:
# only new files take extra space, and a deleted file can still be restored.
if [ -d "$DATA/files" ]; then
  mkdir -p "$DEST/files-$STAMP"
  (cd "$DATA/files" && find . -path ./.uploading -prune -o -type f -print | cpio -pdlm --quiet "$DEST/files-$STAMP") 2>/dev/null \
    || cp -al "$DATA/files/." "$DEST/files-$STAMP/"
  rm -rf "$DEST/files-$STAMP/.uploading"
fi

find "$DEST" -maxdepth 1 -name 'ares-*.db.gz' -mtime +14 -delete
find "$DEST" -maxdepth 1 -type d -name 'files-*' -mtime +14 -exec rm -rf {} +
