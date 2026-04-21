#!/usr/bin/env bash
# Run hermes (or any MiniMax-hitting command) with an exclusive lock that tells
# the openclaw-hermes COO bridge to yield its tick while we're active. Prevents
# the MiniMax plan's 1-2 concurrent-agent ceiling from producing 529s or
# terminated streams when the bridge and a manual hermes call race on the same
# upstream account.
#
# Usage:
#   scripts/hermes-exclusive.sh
#   scripts/hermes-exclusive.sh chat -q "summarize the firm"
#   scripts/hermes-exclusive.sh chat --skills firm-architecture
#
# Lock file: ${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}
# Bridge honors lock if mtime < 5 min (stale safety).

set -euo pipefail
LOCK="${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}"

touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# Refresh the lock every 60s while hermes runs, so long-running sessions don't look stale.
(
  while :; do sleep 60; touch "$LOCK" 2>/dev/null || exit 0; done
) &
REFRESHER=$!
trap 'kill "$REFRESHER" 2>/dev/null; rm -f "$LOCK"' EXIT INT TERM

exec hermes "$@"
