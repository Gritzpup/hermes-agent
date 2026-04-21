#!/usr/bin/env bash
# Dispatch hermes inside a tmux window so the user can watch the subagent
# live. Wraps scripts/hermes-exclusive.sh (so the MiniMax stagger-lock is
# honored and the openclaw-hermes COO bridge yields while the subagent works).
#
# Creates/reuses a shared tmux session named "hermes-agents". Every invocation
# lands in a new window named by timestamp, and output is also tee'd to a log
# file so programmatic callers (Claude, other scripts) can poll status from
# outside tmux.
#
# Usage:
#   scripts/hermes-watch.sh chat --provider minimax -m MiniMax-M2.7 --yolo \
#       -s firm-architecture -q "your prompt"
#
#   scripts/hermes-watch.sh <any-hermes-subcommand-and-args>
#
# Watch live:  tmux attach -t hermes-agents
#   Ctrl-b 0/1/2 ... — switch windows
#   Ctrl-b d       — detach (agents keep running)
#   Ctrl-b s       — window list

set -euo pipefail

SESSION="${HERMES_WATCH_SESSION:-hermes-agents}"
TS="$(date +%H%M%S)"
WIN="${HERMES_WATCH_LABEL:-job}-${TS}"
LOG_DIR="${HERMES_WATCH_LOG_DIR:-/tmp}"
LOG="${LOG_DIR}/hermes-watch-${TS}.log"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXCLUSIVE_WRAPPER="$SCRIPT_DIR/hermes-exclusive.sh"

if [ ! -x "$EXCLUSIVE_WRAPPER" ]; then
  echo "hermes-watch: missing $EXCLUSIVE_WRAPPER" >&2
  exit 1
fi

# Ensure tmux session exists. Idempotent — won't disturb running windows.
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -n controller 'echo "hermes-agents session ready. New subagent windows will appear as they launch."; exec bash'
  echo "[hermes-watch] session created: $SESSION"
fi

# Quote every arg so passthrough is safe even with spaces / prompts.
ARGS=""
for a in "$@"; do
  printf -v esc '%q' "$a"
  ARGS="$ARGS $esc"
done

# Launch in a new window, mirror stdout+stderr to LOG, keep window alive on exit
# so the user can scrollback. `remain-on-exit` is a per-window tmux option.
tmux new-window -t "$SESSION" -n "$WIN" \
  "bash -lc '${EXCLUSIVE_WRAPPER}${ARGS} 2>&1 | tee $(printf '%q' "$LOG"); echo; echo \"[window kept for scrollback — Ctrl-b & to kill]\"; exec bash'"
tmux set-window-option -t "${SESSION}:${WIN}" remain-on-exit on 2>/dev/null || true

echo "[hermes-watch] launched in tmux ${SESSION}:${WIN}"
echo "  watch: tmux attach -t ${SESSION}"
echo "  log:   ${LOG}"
