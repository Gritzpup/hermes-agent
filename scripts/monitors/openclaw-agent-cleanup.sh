#!/bin/bash
# openclaw-agent-cleanup: prunes stale openclaw sessions + kills hung openclaw-agent processes.
# Keeps: agent:main:main (human/this session) + agent:main:explicit:bridge (the COO).
# Everything else (subagents, debug sessions, orphaned agents) gets deleted.
#
# Also monitors the bridge's /health endpoint and force-restarts it if tickInFlight
# has been true for > 5 minutes (indicating a hung openclaw call that missed its timeout).

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

BRIDGE_HEALTH="http://localhost:4395/health"
BRIDGE_HUNG_THRESHOLD_SEC=300  # 5 minutes
SLEEP_SEC=600  # 10 min between cleanup passes

OPENCLAW=/home/ubuntubox/.npm-global/bin/openclaw
SESSIONS_JSON="$HOME/.openclaw/agents/main/sessions/sessions.json"
LOG_PREFIX="[openclaw-cleanup]"

# Long-running loop: tilt's serve_cmd expects a persistent process. Each pass does
# one full cleanup cycle, then sleeps. Matches the pattern used by coo-sanity et al.
while true; do

echo "$LOG_PREFIX $(date +%H:%M:%S) starting cleanup..."

# ── 1. Session pruning ────────────────────────────────────────────────────────
if [ -f "$SESSIONS_JSON" ]; then
  KEEP_KEYS='("agent:main:main","agent:main:explicit:bridge")'
  python3 << PYEOF
import json, sys, os

sessions_path = os.path.expanduser("$SESSIONS_JSON")
try:
    with open(sessions_path, 'r') as f:
        sessions = json.load(f)
except Exception as e:
    print("$LOG_PREFIX sessions.json read failed: $e")
    sys.exit(0)

keep = {"agent:main:main", "agent:main:explicit:bridge"}
before = len(sessions)
removed = []
for k in list(sessions.keys()):
    if k not in keep:
        removed.append(k)
        del sessions[k]

if removed:
    with open(sessions_path, 'w') as f:
        json.dump(sessions, f, indent=2)
    for r in removed:
        print(f"$LOG_PREFIX removed session: {r}")
    print(f"$LOG_PREFIX pruned {len(removed)} stale sessions ({before} -> {len(sessions)} remaining)")
else:
    print(f"$LOG_PREFIX sessions clean ({len(sessions)} sessions, nothing to remove)")
PYEOF
else
  echo "$LOG_PREFIX sessions.json not found — skipping session pruning"
fi

# ── 2. Kill hung openclaw-agent processes ───────────────────────────────────
# The bridge spawns openclaw-agent with --session-id hermes-bridge. Any OTHER
# openclaw-agent processes (orphaned subagents, debug runs) are hung and should die.
# We identify bridge agents by checking their command-line args for "hermes-bridge".
# Note: the bridge's own agent will exit naturally when the call completes.

# Find real openclaw agent processes (the binary invoked with `agent` as first arg).
# CRITICAL: a naive "openclaw-agent" pgrep ALSO matches this script's own name
# (openclaw-agent-cleanup.sh) and any bash shell running a command that mentions it,
# including pi, claude's Bash tool, and our own parent — so we'd kill ourselves.
# We match `openclaw` + `agent` as consecutive cmdline tokens, and skip PIDs whose
# cmdline contains "cleanup" as a final safety.
MY_PID=$$
MY_PPID=$PPID
for pid in $(pgrep -f "openclaw +agent( |$)" 2>/dev/null); do
  if [ "$pid" = "$MY_PID" ] || [ "$pid" = "$MY_PPID" ]; then
    continue
  fi
  cmdline=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ')
  # Belt-and-braces: never kill anything that mentions this script.
  if echo "$cmdline" | grep -q "cleanup"; then
    continue
  fi
  if echo "$cmdline" | grep -q "hermes-bridge"; then
    echo "$LOG_PREFIX bridge agent PID $pid — leaving alone (bridge manages this)"
  else
    echo "$LOG_PREFIX killing orphaned agent PID $pid — $cmdline"
    kill "$pid" 2>/dev/null && echo "$LOG_PREFIX killed PID $pid" || echo "$LOG_PREFIX failed to kill PID $pid"
  fi
done

# ── 3. Bridge hung-tick watchdog ─────────────────────────────────────────────
# If tickInFlight has been true for > 5 min, the openclaw call is hung.
# Force-restart the bridge via tilt trigger so it clears its in-memory state.

HEALTH=$(curl -fsS --max-time 5 "$BRIDGE_HEALTH" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  echo "$LOG_PREFIX bridge unreachable at $BRIDGE_HEALTH — skipping hung-tick check"
else
  TICK_IN_FLIGHT=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('tickInFlight') else 'false')" 2>/dev/null)
  LAST_POLL=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('lastPollAt',''))" 2>/dev/null)
  SKIPPED=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('skippedBecauseBusy',0))" 2>/dev/null)

  echo "$LOG_PREFIX bridge tickInFlight=$TICK_IN_FLIGHT lastPoll=$LAST_POLL skipped=$SKIPPED"

  if [ "$TICK_IN_FLIGHT" = "true" ] && [ -n "$LAST_POLL" ]; then
    LAST_POLL_EPOCH=$(date -d "$LAST_POLL" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE_SEC=$((NOW_EPOCH - LAST_POLL_EPOCH))
    if [ "$AGE_SEC" -gt "$BRIDGE_HUNG_THRESHOLD_SEC" ]; then
      echo "$LOG_PREFIX BRIDGE HUNG: tickInFlight for ${AGE_SEC}s (> ${BRIDGE_HUNG_THRESHOLD_SEC}s threshold) — triggering tilt restart"
      emit_ops_event "critical" "openclaw-agent-cleanup" \
        "Bridge hung tick detected: tickInFlight=${AGE_SEC}s — force-restarting via tilt trigger" \
        "{\"ageSeconds\":$AGE_SEC,\"thresholdSeconds\":$BRIDGE_HUNG_THRESHOLD_SEC}"
      cd /mnt/Storage/github/hermes-trading-firm && tilt trigger openclaw-hermes 2>&1
    else
      echo "$LOG_PREFIX bridge tick in flight for ${AGE_SEC}s — within threshold, leaving alone"
    fi
  fi

  if [ "$SKIPPED" -gt 50 ]; then
    echo "$LOG_PREFIX WARNING: skippedBecauseBusy=$SKIPPED (> 50) — bridge tick mutex may be stuck — triggering tilt restart"
    emit_ops_event "warn" "openclaw-agent-cleanup" \
      "Bridge skip count elevated: skippedBecauseBusy=$SKIPPED — possible mutex deadlock — restarting" \
      "{\"skipped\":$SKIPPED}"
    cd /mnt/Storage/github/hermes-trading-firm && tilt trigger openclaw-hermes 2>&1
  fi
fi

echo "$LOG_PREFIX $(date +%H:%M:%S) cleanup done; sleeping ${SLEEP_SEC}s."
sleep "$SLEEP_SEC"
done
