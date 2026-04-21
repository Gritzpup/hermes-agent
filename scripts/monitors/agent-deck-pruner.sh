#!/bin/bash
# agent-deck-pruner: every 2 min, remove Agent Deck sessions whose underlying
# tmux session has died and stayed dead for >= 5 min. Belt-and-suspenders for
# cases where the bashrc EXIT trap didn't fire (SIGKILL, detach+close, etc.)
# plus it cleans up stale Claude subagent dispatches.
#
# A "permanent set" of sessions is NEVER pruned — these are the fixture
# windows in the trading-firm group (claude-firm, hermes-firm, coo-bridge,
# cfo, openclaw-gateway, hermes-api, firm-fleet). We only prune titles
# outside that set whose tmux session is gone for 5+ min.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

SLEEP_SEC=120   # scan every 2 min
STALE_THRESHOLD_SEC=300   # 5 min without tmux session = prune

# Titles we NEVER prune — the permanent fleet in the TUI.
KEEP_TITLES="claude-firm|hermes-firm|coo-bridge|cfo|openclaw-gateway|hermes-api|firm-fleet|test-shell"

# Track when each missing-tmux session was first seen missing. Format:
#   <session-id> <first-missed-epoch>
STATE_FILE="/tmp/agent-deck-pruner-state"
touch "$STATE_FILE"

LOG_PREFIX="[agent-deck-pruner]"

prune_once() {
  local now
  now=$(date +%s)
  # Build set of live tmux session names so we can tell if a tracked
  # Agent Deck session's tmux counterpart has died.
  local live_tmux
  live_tmux=$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)

  # Dump Agent Deck's sessions as JSON. Skip if agent-deck not reachable.
  local ad_json
  ad_json=$(agent-deck list -json 2>/dev/null || true)
  [ -z "$ad_json" ] && return 0

  # Load prior state into an associative array.
  declare -A first_missed=()
  if [ -s "$STATE_FILE" ]; then
    while read -r id ts; do
      [ -n "$id" ] && first_missed["$id"]="$ts"
    done < "$STATE_FILE"
  fi

  # Inspect each Agent Deck session.
  local new_state=""
  echo "$ad_json" | python3 -c '
import sys, json
data = json.load(sys.stdin)
for s in data:
    print(f"{s[\"id\"]}\t{s[\"title\"]}\t{s.get(\"tmux_session\",\"\")}")
' | while IFS=$'\t' read -r id title tmux_sess; do
    # Preserve permanent fixtures no matter what.
    if echo "$title" | grep -Eq "^($KEEP_TITLES)$"; then
      continue
    fi

    if [ -z "$tmux_sess" ]; then
      continue
    fi

    if echo "$live_tmux" | grep -qxF "$tmux_sess"; then
      # tmux session alive — clear any prior missed-timestamp.
      continue
    fi

    # tmux session missing. Stamp first-missed if this is the first sighting,
    # or prune if past the threshold.
    local_first="${first_missed[$id]:-}"
    if [ -z "$local_first" ]; then
      echo "$id $now" >> "${STATE_FILE}.new"
      echo "$LOG_PREFIX $(date +%H:%M) noting missing tmux for '$title' (id=$id)"
      continue
    fi
    age=$((now - local_first))
    if [ "$age" -ge "$STALE_THRESHOLD_SEC" ]; then
      echo "$LOG_PREFIX $(date +%H:%M) pruning '$title' (id=$id) — tmux gone ${age}s"
      agent-deck remove "$id" >/dev/null 2>&1 || true
    else
      # Not yet stale, carry forward.
      echo "$id $local_first" >> "${STATE_FILE}.new"
    fi
  done

  # Atomically replace state file.
  mv -f "${STATE_FILE}.new" "$STATE_FILE" 2>/dev/null || : > "$STATE_FILE"
}

echo "$LOG_PREFIX $(date +%H:%M:%S) starting; scanning every ${SLEEP_SEC}s; stale threshold ${STALE_THRESHOLD_SEC}s"
while true; do
  prune_once
  sleep "$SLEEP_SEC"
done
