#!/bin/bash
# Hermes Firm — Reactive Alert Handler
# Runs on heartbeat breach OR via cron every 5 min
# Philosophy: diagnose immediately, self-heal when possible, escalate if not

set -e

REPO="/mnt/Storage/github/hermes-trading-firm"
cd "$REPO"
source .env 2>/dev/null

LOG="[$(date '+%Y-%m-%d %H:%M:%S')]"
ALERTS_FILE="/tmp/firm-alerts.log"
SEEN_FILE="/tmp/firm-alerts-seen.json"
mkdir -p "$(dirname "$ALERTS_FILE")"

# Load seen alerts to avoid repeat spam
SEEN='{}'
[ -f "$SEEN_FILE" ] && SEEN=$(cat "$SEEN_FILE") || true

log_alert() {
  echo "$LOG ALERT: $1" | tee -a "$ALERTS_FILE"
}

mark_seen() {
  # Mark alert as seen (simple JSON append)
  echo "{\"id\":\"$1\",\"ts\":\"$(date -Iseconds)\"}" >> "$SEEN_FILE"
}

is_new_alert() {
  ! grep -q "\"$1\"" "$SEEN_FILE" 2>/dev/null
}

# ─── HEALTH CHECKS ────────────────────────────────────────────

# 1. API health
API_HEALTH=$(curl -s "http://localhost:4300/health" --max-time 3 2>/dev/null | grep -c '"ok"' || echo 0)

# 2. Strategy director last run (error detector)
SD_STATUS=$(curl -s "http://localhost:4300/api/strategy-director/latest" --max-time 5 2>/dev/null)
SD_ERROR=$(echo "$SD_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ERROR' if d.get('error') else 'OK')" 2>/dev/null || echo "UNKNOWN")
SD_RUNID=$(echo "$SD_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('runId','?')[:8])" 2>/dev/null || echo "?")

# 3. Maker status
MAKER_STATUS=$(curl -s "http://localhost:4300/api/maker" --max-time 5 2>/dev/null)
MAKER_BTC_MODE=$(echo "$MAKER_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((s['mode'] for s in d['quotes']['states'] if s['symbol']=='BTC-USD'),'?'))" 2>/dev/null || echo "?")

# 4. Emergency halt
HALT=$(cat services/api/.runtime/emergency-halt.json 2>/dev/null || echo '{}')
HALT_REASON=$(echo "$HALT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason','?')[:100])" 2>/dev/null || echo "?")

# 5. Synthetic trades detection (Phase H guard failure = CRITICAL)
SYnth_COUNT=$(curl -s "http://localhost:4300/api/stats" --max-time 5 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('syntheticTrades',0))" 2>/dev/null || echo 0)

# 6. EOD stats
EOD_STATS=$(curl -s "http://localhost:4305/stats" --max-time 5 2>/dev/null)
EOD_ERROR=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ERROR' if 'error' in d else 'OK')" 2>/dev/null || echo "UNKNOWN")

# 7. Service ports
CFO_OK=$(curl -s "http://localhost:4309/health" --max-time 3 2>/dev/null | grep -c '"ok"' || echo 0)
COMP_OK=$(curl -s "http://localhost:4310/health" --max-time 3 2>/dev/null | grep -c '"ok"' || echo 0)

echo "$LOG Health: API=$API_HEALTH EOD=$EOD_ERROR CFO=$CFO_OK COMP=$COMP_OK | SD=$SD_ERROR($SD_RUNID) | MakerBTC=$MAKER_BTC_MODE | Synth=$SYNTH_COUNT"

# ─── REACTIVE HEALING ─────────────────────────────────────────

# ALERT 1: API down → restart
if [ "$API_HEALTH" -eq 0 ]; then
  if is_new_alert "api-down"; then
    log_alert "API DOWN — restarting..."
    mark_seen "api-down"
    fuser -k 4300/tcp 4303/tcp 2>/dev/null || true
    sleep 2
    cd "$REPO" && nohup npm run dev:api > /tmp/hermes-api.log 2>&1 &
    sleep 30
    log_alert "API restart complete"
  fi
fi

# ALERT 2: Strategy director stuck with "All providers failed" 
if [ "$SD_ERROR" = "ERROR" ] && is_new_alert "sd-all-providers-failed"; then
  log_alert "Strategy director all-providers-failed — investigating..."
  mark_seen "sd-all-providers-failed"
  
  # Check Ollama connectivity from API process perspective
  OLLAMA_TEST=$(curl -s --max-time 5 "http://192.168.1.8:11434/api/tags" 2>/dev/null | grep -c '"models"' || echo 0)
  if [ "$OLLAMA_TEST" -eq 0 ]; then
    log_alert "Ollama unreachable at 192.168.1.8 — check GPU host"
  else
    log_alert "Ollama reachable but SD failed — forcing cycle..."
    curl -s -X POST "http://localhost:4300/api/strategy-director/cycle/run" --max-time 5 2>/dev/null
  fi
fi

# ALERT 3: Synthetic trades detected (Phase H breach = CRITICAL)
if [ "$SYNTH_COUNT" -gt 0 ] && is_new_alert "synthetic-breach"; then
  log_alert "CRITICAL: $SYNTH_COUNT synthetic trades detected — Phase H breach!"
  mark_seen "synthetic-breach"
  # Immediately halt all trading
  echo '{"halted":true,"reason":"Phase H synthetic trade breach","timestamp":"'"$(date -Iseconds)"'"}' > services/api/.runtime/emergency-halt.json
  log_alert "Emergency halt engaged — manual review required"
fi

# ALERT 4: Maker BTC stuck in taker-watch > 2h (if we tracked timestamps)
# For now just log persistent taker-watch
if [ "$MAKER_BTC_MODE" = "taker-watch" ] && is_new_alert "maker-btc-taker-watch"; then
  log_alert "Maker BTC in taker-watch — spread economics broken (this is expected if spreads < 4bps)"
  mark_seen "maker-btc-taker-watch"
fi

# ALERT 5: Emergency halt not empty
HALTED=$(echo "$HALT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('halted','?'))" 2>/dev/null || echo "?")
if [ "$HALTED" = "true" ]; then
  if is_new_alert "emergency-halt"; then
    log_alert "EMERGENCY HALT ACTIVE: $HALT_REASON"
    mark_seen "emergency-halt"
  fi
fi

# ALERT 6: CFO or Compliance services down
if [ "$CFO_OK" -eq 0 ] && is_new_alert "cfo-down"; then
  log_alert "CFO Arithmetic DOWN — restarting..."
  mark_seen "cfo-down"
  fuser -k 4309/tcp 2>/dev/null || true
  sleep 2
  cd "$REPO" && nohup npm run dev:cfo-arithmetic > /tmp/hermes-cfo.log 2>&1 &
  sleep 15
  log_alert "CFO Arithmetic restarted"
fi

if [ "$COMP_OK" -eq 0 ] && is_new_alert "comp-down"; then
  log_alert "Compliance Vetter DOWN — restarting..."
  mark_seen "comp-down"
  fuser -k 4310/tcp 2>/dev/null || true
  sleep 2
  cd "$REPO" && nohup npm run dev:compliance-vetter > /tmp/hermes-comp.log 2>&1 &
  sleep 15
  log_alert "Compliance Vetter restarted"
fi

# ALERT 7: EOD stats error
if [ "$EOD_ERROR" = "ERROR" ] && is_new_alert "eod-error"; then
  log_alert "EOD stats returning error — checking..."
  mark_seen "eod-error"
  fuser -k 4305/tcp 2>/dev/null || true
  sleep 2
  cd "$REPO" && nohup npm run dev:eod-analysis > /tmp/hermes-eod.log 2>&1 &
  sleep 20
  log_alert "EOD service restarted"
fi

# ─── PERFORMANCE DEGRADATION CHECKS ────────────────────────────
PNL=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalPnl',0))" 2>/dev/null || echo 0)
XRP=$(echo "$EOD_STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('xrpConcentration',0))" 2>/dev/null || echo 0)

# XRP concentration > 75% → reduce (already handled by 30-min review, but be aggressive)
if (( $(echo "$XRP > 75" | bc -l 2>/dev/null || echo 0) )) && is_new_alert "xrp-concentration-high"; then
  log_alert "XRP concentration $XRP% — triggering immediate reduction"
  mark_seen "xrp-concentration-high"
  # Run the auto-review's XRP fix
  sed -i 's/xrpGrid\.allocationMultiplier = 2\.0;/xrpGrid.allocationMultiplier = 1.5;/' services/api/src/index.ts 2>/dev/null
  log_alert "XRP multiplier reduced to 1.5"
  # Commit + push
  cd "$REPO" && git add -A && git commit -m "auto: XRP concentration fix ($(date '+%Y-%m-%d %H:%M'))" && git push origin master 2>/dev/null
fi

echo "$LOG Alert check complete"
