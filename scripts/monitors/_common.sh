#!/bin/bash
# Shared helpers for the operational monitors. Source this at the top of each monitor script.

EVENTS_JSONL="/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/events.jsonl"

# emit_ops_event <severity> <monitor> <message> [extra-json]
# Writes a COO-visible event into the firm's event stream so the bridge picks it up next tick.
# severity: info|warn|critical
emit_ops_event() {
  local severity="$1"
  local monitor="$2"
  local message="$3"
  local extra="${4:-}"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local extra_fragment=""
  if [ -n "$extra" ]; then
    extra_fragment=",\"extra\":$extra"
  fi
  printf '{"timestamp":"%s","type":"ops-warn","source":"%s","severity":"%s","message":%s%s}\n' \
    "$ts" "$monitor" "$severity" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$extra_fragment" \
    >> "$EVENTS_JSONL" 2>/dev/null
}
