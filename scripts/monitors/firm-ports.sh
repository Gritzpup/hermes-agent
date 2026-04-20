#!/bin/bash
# firm-ports: every 5 min, verify all expected service ports are listening.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

# Port → service name (for meaningful warnings).
# Verified 2026-04-20 via ss + curl /health — port 4307 deliberately omitted
# because backtest moved 4305→4308 per commit 365252f and no service owns 4307.
declare -A PORTS=(
  [4300]="hermes-api"
  [4301]="hermes-risk-engine"
  [4302]="hermes-market-data"
  [4303]="hermes-api-broker-embedded"
  [4304]="hermes-review-loop"
  [4305]="hermes-strategy-lab"
  [4306]="hermes-daily-diary"
  [4308]="hermes-backtest"
  [4309]="hermes-ancillary-4309"
  [4310]="hermes-ancillary-4310"
  [4395]="openclaw-hermes-bridge"
  [18789]="openclaw-gateway"
  [16379]="nsfw-bot-redis"
  [16380]="sfw-bot-redis"
)

while true; do
  TS=$(date +%H:%M)
  MISSING=()

  # Capture ss once per tick to avoid 13 subprocess calls
  LISTEN_COLS=$(ss -ltn 2>/dev/null | awk 'NR>1 {print $4}')

  for P in "${!PORTS[@]}"; do
    if ! grep -Eq ":${P}$" <<< "$LISTEN_COLS"; then
      MISSING+=("$P(${PORTS[$P]})")
    fi
  done

  if [ ${#MISSING[@]} -eq 0 ]; then
    echo "[firm-ports] $TS all ${#PORTS[@]} ports listening"
  else
    MSG="ports missing: ${MISSING[*]}"
    echo "[firm-ports] $TS WARN $MSG"
    emit_ops_event "warn" "firm-ports" "$MSG"
  fi

  sleep 300
done
