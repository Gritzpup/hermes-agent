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

# Long -q prompts break tmux new-window's single-argument shell string
# (escape/quote nesting fails). Instead write a tiny dispatcher script that
# execs hermes-exclusive with the original args, then have tmux run that
# script. Simple, robust to any prompt content including newlines.
DISPATCHER="${LOG_DIR}/hermes-watch-dispatcher-${TS}.sh"
{
  echo "#!/usr/bin/env bash"
  echo "set -o pipefail"
  # Each arg goes through bash %q so it survives disk serialization.
  printf 'exec %q' "$EXCLUSIVE_WRAPPER"
  for a in "$@"; do
    printf ' %q' "$a"
  done
  echo
} > "$DISPATCHER"
chmod +x "$DISPATCHER"

# Launch in a new window. Pipe dispatcher output to tee for external polling.
# remain-on-exit keeps the window after dispatcher exits so user can scroll back.
tmux new-window -t "$SESSION" -n "$WIN" \
  "bash -lc \"'$DISPATCHER' 2>&1 | tee '$LOG'; echo; echo '[window kept for scrollback — Ctrl-b & to kill]'; exec bash\""
tmux set-window-option -t "${SESSION}:${WIN}" remain-on-exit on 2>/dev/null || true

echo "[hermes-watch] launched in tmux ${SESSION}:${WIN}"
echo "  watch: tmux attach -t ${SESSION}"
echo "  log:   ${LOG}"
