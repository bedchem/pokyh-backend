#!/bin/bash
# Point-in-time recovery files for the POKYH database (the db-archiver service).
#
# Runs next to MySQL with the same image and keeps, in the backups volume
# (BACKUP_DIR/pitr, where the API's off-site sync picks them up):
#
#   pitr/base/base-<UTC time>.sql.gz   a consistent dump every PITR_BASE_HOURS,
#                                       with the binary log position it starts at
#   pitr/binlog/binlog.NNNNNN           every closed binary log since then
#
# Together they rebuild the database as it was at any archived moment
# (deploy/db/pitr-restore.sh). The current binary log is closed whenever it
# has grown and is PITR_FLUSH_MINUTES old, so at most that much is missing
# from the archive. Nothing here ever writes to the database's data; the data
# volume is mounted read-only and only closed (finished) log files are copied.

set -u -o pipefail
umask 022

SOURCE=/var/lib/mysql-source
OUT=/backups/pitr
HOST="${PITR_DB_HOST:-mysql}"
BASE_HOURS="${PITR_BASE_HOURS:-6}"
FLUSH_MINUTES="${PITR_FLUSH_MINUTES:-5}"
KEEP_DAYS="${PITR_RETENTION_DAYS:-14}"

log() { echo "[pitr] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

: "${MYSQL_PWD:?MYSQL_PWD is required}"
: "${DB_NAME:?DB_NAME is required}"
export MYSQL_PWD

sql() { mysql --host="$HOST" --user=root --batch --skip-column-names -e "$1"; }

mkdir -p "$OUT/base" "$OUT/binlog"

until mysqladmin --host="$HOST" --user=root ping --silent >/dev/null 2>&1; do
  log "waiting for MySQL at $HOST"
  sleep 5
done
if [ "$(sql 'SELECT @@log_bin')" != "1" ]; then
  log "binary logging is off on the server: only base dumps are kept (no point-in-time recovery between them)"
fi
log "archiving to $OUT (base dump every ${BASE_HOURS}h, binary logs closed every ${FLUSH_MINUTES} min, kept ${KEEP_DAYS} days)"

last_flush=$(date +%s)
last_position=""

newest_base() { ls -1 "$OUT/base"/base-*.sql.gz 2>/dev/null | tail -n 1; }

make_base() {
  local stamp file
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  file="$OUT/base/base-$stamp.sql.gz"
  # --source-data=2 records the binary log position of the snapshot as a
  # comment; the dump itself is consistent (--single-transaction). Triggers
  # are left out like in the API's own backups: the cluster capture triggers
  # are recreated by the application.
  if mysqldump --host="$HOST" --user=root --single-transaction --source-data=2 --routines --events \
      --skip-triggers --hex-blob --set-gtid-purged=OFF "$DB_NAME" | gzip > "$file.part" \
      && gzip -t "$file.part"; then
    mv "$file.part" "$file"
    log "base dump written: $(basename "$file") ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.part"
    log "base dump FAILED, retrying in a minute"
    return 1
  fi
}

prune() {
  # Base dumps older than KEEP_DAYS go (the newest always stays), then every
  # binary log older than the oldest remaining base dump's starting log.
  local keep oldest start_file start_num name num f
  keep=$(newest_base)
  for f in "$OUT/base"/base-*.sql.gz; do
    [ -e "$f" ] && [ "$f" != "$keep" ] || continue
    [ $(( $(date +%s) - $(stat -c %Y "$f") )) -gt $((KEEP_DAYS * 86400)) ] && rm -f "$f"
  done
  oldest=$(ls -1 "$OUT/base"/base-*.sql.gz 2>/dev/null | head -n 1)
  [ -n "$oldest" ] || return 0
  start_file=$(gzip -dc "$oldest" 2>/dev/null | head -n 60 | sed -n "s/.*SOURCE_LOG_FILE='\([^']*\)'.*/\1/p" | head -n 1)
  [ -n "$start_file" ] || return 0
  start_num=$((10#${start_file##*.}))
  for f in "$OUT/binlog"/*.[0-9]*; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    num=$((10#${name##*.}))
    [ "$num" -lt "$start_num" ] && rm -f "$f"
  done
}

while true; do
  status=$(sql 'SHOW BINARY LOG STATUS' 2>/dev/null)
  active=$(printf '%s' "$status" | cut -f1)
  position=$(printf '%s' "$status" | cut -f2)
  now=$(date +%s)

  # Close the current log when it has grown and is old enough, so it can be archived.
  if [ -n "$active" ] && [ "$position" != "$last_position" ] && [ $((now - last_flush)) -ge $((FLUSH_MINUTES * 60)) ]; then
    if sql 'FLUSH BINARY LOGS' >/dev/null 2>&1; then
      last_flush=$now
      status=$(sql 'SHOW BINARY LOG STATUS' 2>/dev/null)
      active=$(printf '%s' "$status" | cut -f1)
      position=$(printf '%s' "$status" | cut -f2)
    fi
  fi
  last_position=$position

  # Copy every closed log not archived yet (the active one is still being written).
  if [ -n "$active" ]; then
    for f in "$SOURCE"/"${active%.*}".[0-9]*; do
      [ -e "$f" ] || continue
      name=$(basename "$f")
      [ "$name" = "$active" ] && continue
      [ -e "$OUT/binlog/$name" ] && continue
      if cp -p "$f" "$OUT/binlog/$name.part" && mv "$OUT/binlog/$name.part" "$OUT/binlog/$name"; then
        log "binary log archived: $name"
      else
        rm -f "$OUT/binlog/$name.part"
      fi
    done
  fi

  # A base dump when none is younger than BASE_HOURS.
  base=$(newest_base)
  if [ -z "$base" ] || [ $((now - $(stat -c %Y "$base"))) -ge $((BASE_HOURS * 3600)) ]; then
    make_base && prune
  fi

  sleep 60
done
