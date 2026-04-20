#!/bin/bash
# openclaw-gateway: every 60s, verify the openclaw gateway daemon is running + listening on 18789.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

OPENCLAW=/home/ubuntubox/.npm-global/bin/openclaw

while true; do
  TS=$(date +%H:%M)

  # Primary health check: is port 18789 listening? (ground truth — `openclaw daemon status`
  # can't reach the user systemd bus from tilt's system-systemd context, so we rely on
  # socket state rather than systemctl probe results.)
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ':18789$'; then
    LISTEN="yes"
  else
    LISTEN="no"
  fi

  # Secondary: is a gateway process with the right name actually alive?
  if pgrep -f "openclaw-gatewa" >/dev/null 2>&1; then
    PROC="alive"
  else
    PROC="dead"
  fi

  echo "[openclaw-gateway] $TS listen18789=$LISTEN proc=$PROC"

  if [ "$LISTEN" != "yes" ] || [ "$PROC" != "alive" ]; then
    MSG="openclaw gateway unhealthy — listen18789=$LISTEN proc=$PROC — bridge will fail every agent call"
    echo "[openclaw-gateway] WARN $MSG"
    emit_ops_event "critical" "openclaw-gateway" "$MSG"
  fi

  sleep 60
done
