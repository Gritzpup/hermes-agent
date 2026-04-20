#!/bin/bash
# coo-sanity: every 2 min, verify the bridge is alive + COO heartbeat is fresh.
# Emits ops-warn events into the firm's event stream when anomalies are detected,
# so the COO sees its own health problems on its next tick and can act.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

LAST_WARNED_CALLS=-1

while true; do
  TS=$(date +%H:%M)

  HEALTH=$(curl -fsS --max-time 3 http://localhost:4395/health 2>/dev/null || echo '{}')
  HB=$(curl -fsS --max-time 3 http://localhost:4300/api/coo/heartbeat 2>/dev/null || echo '{}')

  BRIDGE_OK=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]); print('yes' if d.get('status')=='healthy' else 'NO')" "$HEALTH" 2>/dev/null || echo "UNKNOWN")
  COO_CALLS=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]); print(d.get('cooCalls','?'))" "$HEALTH" 2>/dev/null || echo "?")
  COO_OK=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]); print(d.get('cooSuccesses','?'))" "$HEALTH" 2>/dev/null || echo "?")
  HB_AGE=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]); print(d.get('ageSec','?'))" "$HB" 2>/dev/null || echo "?")
  HB_STALE=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]); print('YES' if d.get('stale') else 'no')" "$HB" 2>/dev/null || echo "?")

  echo "[coo-sanity] $TS bridgeOk=$BRIDGE_OK heartbeatAge=${HB_AGE}s stale=$HB_STALE cooCalls=$COO_CALLS cooSuccesses=$COO_OK"

  if [ "$BRIDGE_OK" != "yes" ]; then
    echo "[coo-sanity] WARN bridge /health unreachable or not healthy"
    emit_ops_event "critical" "coo-sanity" "openclaw-hermes bridge /health returned unhealthy or unreachable — COO is blind to the firm"
  fi

  if [ "$HB_STALE" = "YES" ]; then
    echo "[coo-sanity] WARN heartbeat stale — bridge may be deaf"
    emit_ops_event "critical" "coo-sanity" "bridge heartbeat stale (>15min) — COO may have stopped dispatching"
  fi

  sleep 120
done
