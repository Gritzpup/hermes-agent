#!/bin/bash
# openclaw-gateway: every 60s, verify the openclaw gateway daemon is running + listening on 18789.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

OPENCLAW=/home/ubuntubox/.npm-global/bin/openclaw

while true; do
  TS=$(date +%H:%M)

  # runtime= from `openclaw daemon status`
  RUNTIME=$("$OPENCLAW" daemon status 2>&1 | grep -oE 'Runtime: [a-z]+' | awk '{print $2}' | head -1)
  [ -z "$RUNTIME" ] && RUNTIME="unknown"

  # Is port 18789 bound?
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ':18789$'; then
    LISTEN="yes"
  else
    LISTEN="no"
  fi

  echo "[openclaw-gateway] $TS runtime=$RUNTIME listen18789=$LISTEN"

  if [ "$RUNTIME" != "running" ] || [ "$LISTEN" != "yes" ]; then
    MSG="openclaw gateway unhealthy — runtime=$RUNTIME listen18789=$LISTEN — bridge will fail every agent call"
    echo "[openclaw-gateway] WARN $MSG"
    emit_ops_event "critical" "openclaw-gateway" "$MSG"
  fi

  sleep 60
done
