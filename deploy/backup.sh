#!/bin/sh
# Daily consistent copy of the ARES database, kept for 14 days.
# Runs from /etc/cron.daily. Copy these files off the server too (see README).
set -eu
SRC=/var/lib/ares/ares.db
DEST=/var/backups/ares
mkdir -p "$DEST"
chmod 700 "$DEST"
[ -f "$SRC" ] || exit 0
STAMP=$(date +%Y-%m-%d)
sqlite3 "$SRC" ".backup '$DEST/ares-$STAMP.db'"
gzip -f "$DEST/ares-$STAMP.db"
find "$DEST" -name 'ares-*.db.gz' -mtime +14 -delete
