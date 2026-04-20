#!/bin/bash
# env-backup: every 6 hours, snapshot hermes-firm's .env into .env-backups/
# with timestamped filename. Prunes backups older than 30 days. Runs in addition
# to whatever change-based backup mechanism already exists (there's something that
# backs up on every .env write; this is the belt to that suspenders).

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

ENV_FILE=/mnt/Storage/github/hermes-trading-firm/.env
BACKUP_DIR=/mnt/Storage/github/hermes-trading-firm/.env-backups
RETAIN_DAYS=30

mkdir -p "$BACKUP_DIR"

while true; do
  TS=$(date +%H:%M)

  if [ ! -f "$ENV_FILE" ]; then
    echo "[env-backup] $TS WARN .env missing — skipping backup cycle"
    emit_ops_event "warn" "env-backup" ".env file missing at $ENV_FILE"
    sleep 21600
    continue
  fi

  # Skip if the last backup is byte-identical to current .env — no point duplicating.
  LAST_BACKUP=$(ls -t "$BACKUP_DIR"/.env.* 2>/dev/null | head -1)
  if [ -n "$LAST_BACKUP" ] && cmp -s "$ENV_FILE" "$LAST_BACKUP"; then
    echo "[env-backup] $TS unchanged since $(basename "$LAST_BACKUP" | cut -c6-) — skip"
  else
    BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)
    BACKUP_PATH="$BACKUP_DIR/.env.${BACKUP_TS}"
    cp "$ENV_FILE" "$BACKUP_PATH"
    chmod 600 "$BACKUP_PATH"
    BYTES=$(wc -c < "$BACKUP_PATH")
    echo "[env-backup] $TS backup: ${BACKUP_TS} (${BYTES} bytes)"
  fi

  # Prune backups older than RETAIN_DAYS days.
  PRUNED=$(find "$BACKUP_DIR" -name '.env.*' -mtime +${RETAIN_DAYS} -delete -print 2>/dev/null | wc -l)
  if [ "$PRUNED" -gt 0 ]; then
    echo "[env-backup] pruned $PRUNED backup(s) older than ${RETAIN_DAYS} days"
  fi

  TOTAL=$(ls "$BACKUP_DIR"/.env.* 2>/dev/null | wc -l)
  echo "[env-backup] total backups on disk: $TOTAL"

  sleep 21600  # 6 hours
done
