#!/usr/bin/env bash
# Run hermes with an exclusive lock. Legacy wrapper — the MiniMax concurrency cap
# no longer applies since the COO bridge now calls Kimi directly. Kept for
# backward compatibility with existing workflows.
#
# Usage:
#   scripts/hermes-exclusive.sh
#   scripts/hermes-exclusive.sh chat -q "summarize the firm"
#   scripts/hermes-exclusive.sh chat --skills firm-architecture

set -euo pipefail

LOCK="${MINIMAX_BUSY_LOCK:-/tmp/minimax-busy.lock}"
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

(
  while :; do sleep 60; touch "$LOCK" 2>/dev/null || exit 0; done
) &
REFRESHER=$!
trap 'kill "$REFRESHER" 2>/dev/null; rm -f "$LOCK"' EXIT INT TERM

exec hermes "$@"
