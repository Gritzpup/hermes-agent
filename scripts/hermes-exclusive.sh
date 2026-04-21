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
#
# Concurrency cap (Phase 4b):
#   /tmp/minimax-agents.d/ — one file per live agent, named <caller>-<pid>-<epoch>.pid
#   hermes caller (HERMES_CALLER unset/other): cap=1
#   claude caller (HERMES_CALLER=claude): cap=2

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

# ── Phase 4b: Concurrency cap ────────────────────────────────────────────────
CALLER="${HERMES_CALLER:-hermes}"
if [ "$CALLER" = "claude" ]; then
  CAP=2
else
  CAP=1
fi

AGENTS_DIR="/tmp/minimax-agents.d"
mkdir -p "$AGENTS_DIR"

# GC: remove stale pid files (pid not alive OR mtime > 15 min ago)
STALE_CUTOFF=$(($(date +%s) - 900))
for f in "$AGENTS_DIR"/*.pid; do
  [ -e "$f" ] || continue
  PID=$(basename "$f" | cut -d- -f2)
  # Remove if pid not alive
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$f"
    continue
  fi
  # Remove if mtime stale
  MTIME=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  if [ "$MTIME" -lt "$STALE_CUTOFF" ]; then
    rm -f "$f"
  fi
done

# Count live agents
COUNT=$(ls -1 "$AGENTS_DIR"/*.pid 2>/dev/null | wc -l)

if [ "$COUNT" -ge "$CAP" ]; then
  echo "concurrency cap reached: ${CALLER}=${CAP} (currently ${COUNT} alive)" >&2
  exit 75  # EX_TEMPFAIL
fi

# Register our own pid file: <caller>-<pid>-<epoch>.pid
EPOCH=$(date +%s)
MY_FILE="${AGENTS_DIR}/${CALLER}-$$-${EPOCH}.pid"
echo "$$" > "$MY_FILE"
trap 'rm -f "$MY_FILE"' EXIT INT TERM
# ── End Phase 4b ─────────────────────────────────────────────────────────────

exec hermes "$@"
