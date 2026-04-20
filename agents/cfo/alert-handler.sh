#!/bin/bash
# Hermes Firm - Reactive Alert Handler
# Runs every 5 min via cron (HERMES_ALERT_HANDLER event)
# Philosophy: diagnose immediately, self-heal when possible, escalate if not

REPO="/mnt/Storage/github/hermes-trading-firm"
cd "$REPO"

LOG="[$(date '+%Y-%m-%d %H:%M:%S')]"
ALERTS_FILE="/tmp/firm-alerts.log"
SEEN_FILE="/tmp/firm-alerts-seen.json"
mkdir -p "$(dirname "$ALERTS_FILE")"

# Load seen alerts to avoid repeat spam
is_new_alert() {
  local alert_id="$1"
  ! grep -q "\"$alert_id\"" "$SEEN_FILE" 2>/dev/null
}

mark_seen() {
  local alert_id="$1"
  echo "{\"id\":\"$alert_id\",\"ts\":\"$(date -Iseconds)\"}" >> "$SEEN_FILE"
}

log_alert() {
  echo "$LOG ALERT: $1" | tee -a "$ALERTS_FILE"
}

# --- HEALTH CHECKS ---

API_HEALTH=$(curl -s "http://localhost:4300/health" --max-time 3 2>/dev/null | python3 -c "import sys; print(1 if 'ok' in sys.stdin.read() else 0)")
SD_STATUS=$(curl -s "http://localhost:4300/api/strategy-director/latest" --max-time 5 2>/dev/null)
SD_ERROR=$(echo "$SD_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ERROR' if d.get('error') else 'OK')" 2>/dev/null || echo "UNKNOWN")
SD_RUNID=$(echo "$SD_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('runId','?')[:8])" 2>/dev/null || echo "?")

MAKER_STATUS=$(curl -s "http://localhost:4300/api/maker" --max-time 5 2>/dev/null)
MAKER_BTC_MODE=$(echo "$MAKER_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((s['mode'] for s in d['quotes']['states'] if s['symbol']=='BTC-USD'),'?'))" 2>/dev/null || echo "?")

HALT=$(cat services/api/.runtime/emergency-halt.json 2>/dev/null || echo '{}')
HALTED=$(echo "$HALT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('halted','false'))" 2>/dev/null || echo "false")
HALT_REASON=$(echo "$HALT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason','?')[:100])" 2>/dev/null || echo "?")

EOD_STATS=$(curl -s "http://localhost:4305/stats" --max-time 5 2>/dev/null)
EOD_ERROR=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ERROR' if 'error' in d else 'OK')" 2>/dev/null || echo "UNKNOWN")
PNL=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalPnl',0))" 2>/dev/null || echo 0)
XRP=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('xrpConcentration',0))" 2>/dev/null || echo 0)

CFO_OK=$(curl -s "http://localhost:4309/health" --max-time 3 2>/dev/null | python3 -c "import sys; print(1 if 'ok' in sys.stdin.read() else 0)")
COMP_OK=$(curl -s "http://localhost:4310/health" --max-time 3 2>/dev/null | python3 -c "import sys; print(1 if 'ok' in sys.stdin.read() else 0)")

echo "$LOG Health: API=$API_HEALTH EOD=$EOD_ERROR CFO=$CFO_OK COMP=$COMP_OK | SD=$SD_ERROR($SD_RUNID) | MakerBTC=$MAKER_BTC_MODE"

# --- ALERT 1: API down ---
if [ "$API_HEALTH" -eq 0 ]; then
  if is_new_alert "api-down"; then
    log_alert "API DOWN - restarting..."
    mark_seen "api-down"
    fuser -k 4300/tcp 4303/tcp 2>/dev/null
    sleep 2
    nohup npm run dev:api > /tmp/hermes-api.log 2>&1 &
    sleep 30
    log_alert "API restart complete"
  fi
fi

# --- ALERT 2: Strategy director stuck ---
if [ "$SD_ERROR" = "ERROR" ] && is_new_alert "sd-all-providers-failed"; then
  log_alert "Strategy director all-providers-failed - diagnosing..."
  mark_seen "sd-all-providers-failed"
  OLLAMA_TEST=$(curl -s --max-time 5 "http://192.168.1.8:11434/api/tags" 2>/dev/null | grep -c '"models"' || echo 0)
  if [ "$OLLAMA_TEST" -eq 0 ]; then
    log_alert "Ollama unreachable at 192.168.1.8 - check GPU host"
  else
    log_alert "Ollama reachable - forcing strategy director cycle..."
    curl -s -X POST "http://localhost:4300/api/strategy-director/cycle/run" --max-time 5 2>/dev/null
  fi
fi

# --- ALERT 3: Phase H breach (synthetic trades) ---
SYNTH_COUNT=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('syntheticTrades',0))" 2>/dev/null || echo 0)
if [ "$SYNTH_COUNT" -gt 0 ] && is_new_alert "synthetic-breach"; then
  log_alert "CRITICAL: $SYNTH_COUNT synthetic trades - Phase H breach!"
  mark_seen "synthetic-breach"
  echo "{\"halted\":true,\"reason\":\"Phase H synthetic trade breach\",\"timestamp\":\"$(date -Iseconds)\"}" > services/api/.runtime/emergency-halt.json
  log_alert "Emergency halt engaged - manual review required"
fi

# --- ALERT 4: Emergency halt active ---
if [ "$HALTED" = "true" ] && is_new_alert "emergency-halt"; then
  log_alert "EMERGENCY HALT ACTIVE: $HALT_REASON"
  mark_seen "emergency-halt"
fi

# --- ALERT 5: Services down ---
if [ "$CFO_OK" -eq 0 ] && is_new_alert "cfo-down"; then
  log_alert "CFO Arithmetic DOWN - restarting..."
  mark_seen "cfo-down"
  fuser -k 4309/tcp 2>/dev/null
  sleep 2
  nohup npm run dev:cfo > /tmp/hermes-cfo.log 2>&1 &
  sleep 15
  log_alert "CFO Arithmetic restarted"
fi

if [ "$COMP_OK" -eq 0 ] && is_new_alert "comp-down"; then
  log_alert "Compliance Vetter DOWN - restarting..."
  mark_seen "comp-down"
  fuser -k 4310/tcp 2>/dev/null
  sleep 2
  nohup npm run dev:compliance > /tmp/hermes-comp.log 2>&1 &
  sleep 15
  log_alert "Compliance Vetter restarted"
fi

if [ "$EOD_ERROR" = "ERROR" ] && is_new_alert "eod-error"; then
  log_alert "EOD stats ERROR - restarting service..."
  mark_seen "eod-error"
  fuser -k 4305/tcp 2>/dev/null
  sleep 2
  nohup npm run dev:eod-analysis > /tmp/hermes-eod.log 2>&1 &
  sleep 20
  log_alert "EOD service restarted"
fi

# --- ALERT 6: XRP concentration (>75% - aggressive immediate fix) ---
if (( $(echo "$XRP > 75" | bc -l 2>/dev/null || echo 0) )) && is_new_alert "xrp-concentration-high"; then
  log_alert "XRP concentration $XRP% - immediate reduction to 1.5x"
  mark_seen "xrp-concentration-high"
  sed -i 's/xrpGrid\.allocationMultiplier = 2\.0;/xrpGrid.allocationMultiplier = 1.5;/' services/api/src/index.ts 2>/dev/null
  git add -A
  git commit -m "auto: XRP concentration fix $(date '+%Y-%m-%d %H:%M')"
  git push origin master 2>/dev/null
  log_alert "XRP fix committed and pushed"
fi

echo "$LOG Alert check complete. P&L: \$$PNL | XRP: ${XRP}%"
