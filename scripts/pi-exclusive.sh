#!/usr/bin/env bash
# Run pi with an exclusive lock that tells the openclaw-hermes COO bridge to yield
# its tick while we're active. Legacy wrapper — now a no-op since we use Kimi
# directly (no MiniMax concurrency cap), but kept for backward compatibility.
#
# Usage:
#   scripts/pi-exclusive.sh --provider kimi -m kimi-k2.5 -p "..."
#   scripts/pi-exclusive.sh "free-form pi args"

set -euo pipefail

# Lock file is now ignored by the bridge, but we still clean it up on exit.
LOCK="${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}"
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

(
  while :; do sleep 60; touch "$LOCK" 2>/dev/null || exit 0; done
) &
REFRESHER=$!
trap 'kill "$REFRESHER" 2>/dev/null; rm -f "$LOCK"' EXIT INT TERM

exec pi "$@"
