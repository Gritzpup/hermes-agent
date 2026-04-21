#!/usr/bin/env bash
# Dispatch hermes as an Agent Deck session so it shows up in the TUI alongside
# your interactive Claude/Hermes sessions. Wraps scripts/hermes-exclusive.sh
# (MiniMax stagger-lock for COO-bridge coordination).
#
# Falls back to raw tmux (the old behavior) if agent-deck isn't on PATH, so
# this script stays useful on boxes without Agent Deck installed.
#
# Usage:
#   scripts/hermes-watch.sh chat --provider minimax -m MiniMax-M2.7 --yolo \
#       -s firm-architecture -q "your prompt"
#
#   scripts/hermes-watch.sh <any-hermes-subcommand-and-args>
#
# Watch live:  `deck` (alias for `agent-deck`) — session appears in the TUI
# Fallback:    `wa` (alias for `tmux attach -t hermes-agents`)

set -euo pipefail

TS="$(date +%H%M%S)"
LABEL="${HERMES_WATCH_LABEL:-job}-${TS}"
LOG_DIR="${HERMES_WATCH_LOG_DIR:-/tmp}"
LOG="${LOG_DIR}/hermes-watch-${TS}.log"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXCLUSIVE_WRAPPER="$SCRIPT_DIR/hermes-exclusive.sh"

if [ ! -x "$EXCLUSIVE_WRAPPER" ]; then
  echo "hermes-watch: missing $EXCLUSIVE_WRAPPER" >&2
  exit 1
fi

# Write the full command to a dispatcher script so we don't have to escape
# multi-line prompts through tmux / agent-deck arg parsing.
DISPATCHER="${LOG_DIR}/hermes-watch-dispatcher-${TS}.sh"
{
  echo "#!/usr/bin/env bash"
  echo "set -o pipefail"
  printf 'exec %q' "$EXCLUSIVE_WRAPPER"
  for a in "$@"; do
    printf ' %q' "$a"
  done
  echo
} > "$DISPATCHER"
chmod +x "$DISPATCHER"

# Tee wrapper so logs also land in $LOG for programmatic polling.
RUNNER="${LOG_DIR}/hermes-watch-runner-${TS}.sh"
{
  echo "#!/usr/bin/env bash"
  echo "$DISPATCHER 2>&1 | tee $LOG"
  echo "echo"
  echo "echo '[exited — session kept; close with Ctrl-b & in tmux]'"
  echo "exec bash"
} > "$RUNNER"
chmod +x "$RUNNER"

# Prefer Agent Deck if installed — the dispatch appears in the TUI sidebar.
# Go's flag parser stops on the first non-flag arg, so all flags come BEFORE
# the positional path. Path defaults to cwd if omitted; we pass it explicitly.
if command -v agent-deck >/dev/null 2>&1; then
  agent-deck launch \
    -t "claude-sub-${LABEL}" \
    -g trading-firm \
    -cmd "$RUNNER" \
    "$(pwd)" \
    2>&1 | tail -10
  echo "  watch: agent-deck  (or: deck)"
  echo "  log:   $LOG"
else
  # Fallback: legacy tmux path.
  SESSION="${HERMES_WATCH_SESSION:-hermes-agents}"
  WIN="$LABEL"
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux new-session -d -s "$SESSION" -n controller 'echo "hermes-agents session ready"; exec bash'
  fi
  tmux new-window -t "$SESSION" -n "$WIN" "bash $RUNNER"
  tmux set-window-option -t "${SESSION}:${WIN}" remain-on-exit on 2>/dev/null || true
  echo "[hermes-watch] launched in tmux ${SESSION}:${WIN}"
  echo "  watch: tmux attach -t ${SESSION}"
  echo "  log:   ${LOG}"
fi
