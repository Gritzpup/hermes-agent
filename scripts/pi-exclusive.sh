#!/usr/bin/env bash
# Run pi (or any MiniMax-hitting command) with an exclusive lock that tells the
# openclaw-hermes COO bridge to yield its tick while we're active. Prevents the
# MiniMax plan's 1-2 concurrent-agent ceiling from producing 529s or terminated
# streams when the bridge and a manual pi call race on the same upstream account.
#
# Usage:
#   scripts/pi-exclusive.sh --provider minimax --model MiniMax-M2.7 -p "..."
#   scripts/pi-exclusive.sh "free-form pi args"
#
# Lock file: ${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}
# Bridge honors lock if mtime < 5 min (stale safety).

set -euo pipefail
LOCK="${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}"

touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# Refresh the lock every 60s while pi runs, so long-running sessions don't look stale.
(
  while :; do sleep 60; touch "$LOCK" 2>/dev/null || exit 0; done
) &
REFRESHER=$!
trap 'kill "$REFRESHER" 2>/dev/null; rm -f "$LOCK"' EXIT INT TERM

exec pi "$@"
