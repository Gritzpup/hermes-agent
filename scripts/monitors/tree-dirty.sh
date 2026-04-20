#!/bin/bash
# tree-dirty: every 15 min, log hermes-firm git status if dirty. Surfaces why auto-pull is skipping.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

REPO=/mnt/Storage/github/hermes-trading-firm

while true; do
  TS=$(date +%H:%M)
  cd "$REPO" || { echo "[tree-dirty] $TS cannot cd to $REPO"; sleep 900; continue; }

  DIRTY=$(git status --porcelain 2>/dev/null)
  if [ -z "$DIRTY" ]; then
    echo "[tree-dirty] $TS tree clean — auto-pull unblocked"
  else
    N=$(echo "$DIRTY" | wc -l)
    echo "[tree-dirty] $TS $N dirty entries blocking auto-pull:"
    echo "$DIRTY" | head -20
    # Emit a WARN once every 4 hours so the COO is aware but not spammed
    HOUR=$(date +%H)
    if [ $((HOUR % 4)) -eq 0 ] && [ "$(date +%M)" -lt "15" ]; then
      emit_ops_event "info" "tree-dirty" "hermes-firm has $N uncommitted entries — auto-pull skipping"
    fi
  fi

  sleep 900
done
