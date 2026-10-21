#!/bin/bash
# Rebuilds the POKYH database as it was at a moment in the past, from the
# archive the db-archiver service keeps (deploy/db/archiver.sh).
#
#   docker compose exec db-archiver bash /opt/pokyh-db/pitr-restore.sh "2026-10-21 14:03"   (UTC)
#
# The live database is NOT touched. A temporary MySQL server inside this
# container loads the newest base dump before that moment and replays the
# archived binary logs on top — through MySQL's own replication applier, so
# no extra tools are needed — up to the last log closed before the moment
# (at most PITR_FLUSH_MINUTES earlier). The result is written as a new backup
# file, pokyh-backup-<now>.sql.gz (+ .json describing it), into the backups
# volume. It then shows up in the admin panel under Backups, where it can be
# downloaded, checked and restored like any other backup — a deliberate step
# with its own confirmation, which in a cluster reaches every node.

set -euo pipefail
umask 022

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: pitr-restore.sh \"YYYY-MM-DD HH:MM[:SS]\"   (UTC)" >&2; exit 2; }
target_epoch=$(date -u -d "$TARGET" +%s) || { echo "cannot read the time \"$TARGET\"" >&2; exit 2; }

# `docker compose exec` does not see the archiver's own environment: the
# database name comes from the backend env file mounted into this container.
if [ -z "${DB_NAME:-}" ] && [ -r /run/configs/pokyh-backend.env ]; then
  DB_NAME=$(awk 'index($0, "DB_NAME=") == 1 { sub(/^[^=]*=/, ""); print; exit }' /run/configs/pokyh-backend.env)
fi
: "${DB_NAME:?DB_NAME is required}"
ARCHIVE=/backups/pitr
OUTDIR=/backups
WORK="/tmp/pokyh-pitr-$$"
SOCK="$WORK/mysqld.sock"

log() { echo "[pitr-restore] $*"; }

# ── The newest base dump made before the moment ──────────────────────────────
base=""
for f in "$ARCHIVE"/base/base-*.sql.gz; do
  [ -e "$f" ] || continue
  stamp=$(basename "$f" .sql.gz); stamp=${stamp#base-}
  iso="${stamp:0:10} ${stamp:11:2}:${stamp:14:2}:${stamp:17:2}"
  [ "$(date -u -d "$iso" +%s)" -le "$target_epoch" ] && base="$f"
done
[ -n "$base" ] || { echo "no base dump older than $TARGET in $ARCHIVE/base" >&2; exit 1; }

start_file=$(gzip -dc "$base" | head -n 60 | sed -n "s/.*SOURCE_LOG_FILE='\([^']*\)'.*/\1/p" | head -n 1)
start_pos=$(gzip -dc "$base" | head -n 60 | sed -n "s/.*SOURCE_LOG_POS=\([0-9]*\).*/\1/p" | head -n 1)
[ -n "$start_file" ] && [ -n "$start_pos" ] || { echo "$base names no binary log position" >&2; exit 1; }
start_num=$((10#${start_file##*.}))

# ── The archived logs from the base dump's position to the moment ────────────
logs=()
for f in "$ARCHIVE"/binlog/*.[0-9]*; do
  [ -e "$f" ] || continue
  num=$((10#${f##*.}))
  [ "$num" -ge "$start_num" ] || continue
  # A log's time is its last write (kept by the archiver's copy).
  [ "$(stat -c %Y "$f")" -le "$target_epoch" ] || break
  logs+=("$f")
done
# The logs have to follow each other without a gap.
expected=$start_num
for f in "${logs[@]}"; do
  [ "$((10#${f##*.}))" -eq "$expected" ] || { echo "binary log $(printf '%06d' "$expected") is missing from the archive" >&2; exit 1; }
  expected=$((expected + 1))
done

log "base dump:   $(basename "$base") (from $start_file at $start_pos)"
log "binary logs: ${#logs[@]} ($( [ ${#logs[@]} -gt 0 ] && echo "$(basename "${logs[0]}") … $(basename "${logs[-1]}")" || echo none))"

# ── A temporary server in this container ─────────────────────────────────────
cleanup() {
  [ -S "$SOCK" ] && MYSQL_PWD= mysqladmin --socket="$SOCK" --user=root shutdown >/dev/null 2>&1 || true
  sleep 2
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/data"
chown -R mysql:mysql "$WORK"
mysqld --initialize-insecure --user=mysql --datadir="$WORK/data" >/dev/null 2>&1

# The archived logs become the temporary server's relay logs.
i=0
: > "$WORK/data/relay.index"
for f in "${logs[@]}"; do
  i=$((i + 1))
  name=$(printf 'relay.%06d' "$i")
  cp "$f" "$WORK/data/$name"
  echo "./$name" >> "$WORK/data/relay.index"
done
chown -R mysql:mysql "$WORK/data"

mysqld --user=mysql --datadir="$WORK/data" --socket="$SOCK" --skip-networking --mysqlx=OFF \
  --server-id=4242 --skip-log-bin --relay-log=relay --relay-log-index=relay.index \
  --skip-replica-start --relay-log-purge=OFF --relay-log-recovery=OFF \
  --log-error="$WORK/mysqld.err" &
for _ in $(seq 1 60); do
  MYSQL_PWD= mysqladmin --socket="$SOCK" --user=root ping --silent >/dev/null 2>&1 && break
  sleep 1
done
q() { MYSQL_PWD= mysql --socket="$SOCK" --user=root --batch --skip-column-names -e "$1"; }

log "loading the base dump"
q "CREATE DATABASE \`$DB_NAME\`"
gzip -dc "$base" | MYSQL_PWD= mysql --socket="$SOCK" --user=root "$DB_NAME"

if [ ${#logs[@]} -gt 0 ]; then
  last=$(printf 'relay.%06d' "$i")
  end=$(stat -c %s "$WORK/data/$last")
  log "replaying the binary logs"
  q "CHANGE REPLICATION SOURCE TO SOURCE_HOST='pitr.invalid', RELAY_LOG_FILE='relay.000001', RELAY_LOG_POS=$start_pos"
  q "START REPLICA SQL_THREAD UNTIL RELAY_LOG_FILE='$last', RELAY_LOG_POS=$end"
  while true; do
    running=$(q "SELECT SERVICE_STATE FROM performance_schema.replication_applier_status")
    [ "$running" = "ON" ] || break
    sleep 2
  done
  err=$(q "SELECT LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE FROM performance_schema.replication_applier_status_by_worker WHERE LAST_ERROR_NUMBER <> 0 LIMIT 1")
  [ -z "$err" ] || { echo "replaying failed: $err" >&2; exit 1; }
fi

# ── The result as a new backup file ──────────────────────────────────────────
point=$( [ ${#logs[@]} -gt 0 ] && date -u -d "@$(stat -c %Y "${logs[-1]}")" +%Y-%m-%dT%H:%M:%SZ || echo "$(basename "$base" .sql.gz | sed 's/^base-//')" )
name="pokyh-backup-$(date -u +%Y-%m-%dT%H-%M-%SZ).sql.gz"
log "writing $name"
MYSQL_PWD= mysqldump --socket="$SOCK" --user=root --single-transaction --routines --events --skip-triggers --hex-blob \
  --set-gtid-purged=OFF "$DB_NAME" | gzip > "$OUTDIR/$name.part"
gzip -t "$OUTDIR/$name.part"
sum=$(sha256sum "$OUTDIR/$name.part" | cut -d' ' -f1)
size=$(stat -c %s "$OUTDIR/$name.part")
mv "$OUTDIR/$name.part" "$OUTDIR/$name"
cat > "$OUTDIR/$name.json" <<EOF
{
  "filename": "$name",
  "sha256": "$sum",
  "sizeBytes": $size,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "trigger": "point-in-time",
  "commit": "",
  "pointInTime": "$point",
  "requested": "$(date -u -d "@$target_epoch" +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
log "done: $name holds the database as of $point (UTC). Check and restore it in the admin panel under Backups."
