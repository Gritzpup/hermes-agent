#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

while true; do
  TS=$(date +%H:%M)
  # Get maker tier info from hermes-api's broker-router
  TIER=$(curl -fsS --max-time 5 http://localhost:4300/api/broker-health 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);b=[x for x in d.get('brokers',[]) if x.get('broker')=='coinbase-live'];print(b[0].get('tierName','unknown') if b else 'unknown')" 2>/dev/null || echo "unknown")
  MAKER_BPS=$(curl -fsS --max-time 5 http://localhost:4300/api/broker-health 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);b=[x for x in d.get('brokers',[]) if x.get('broker')=='coinbase-live'];print(b[0].get('makerBps','?') if b else '?')" 2>/dev/null || echo "?")
  echo "[maker-econ] $TS coinbase-live tier=$TIER makerBps=$MAKER_BPS"
  if [ "$MAKER_BPS" = "?" ] || [ "$TIER" = "unknown" ]; then
    emit_ops_event "warn" "maker-econ" "Could not read coinbase-live fee tier — maker allocation may be sub-optimal"
  fi
  sleep 900
done
