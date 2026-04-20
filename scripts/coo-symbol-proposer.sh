#!/bin/bash
# COO backtest-driven symbol proposer. Every 12h picks a candidate crypto
# symbol, asks the firm's backtest service to simulate a 30-day grid on it,
# and if results look promising, writes a recommendation into the COO's
# directive stream so the next bridge tick surfaces it.

set -e
cd /mnt/Storage/github/hermes-trading-firm

TS=$(date +%Y-%m-%d)
DIR=docs/coo-journal/proposals
mkdir -p "$DIR"

# Candidate pool — crypto symbols with enough volume to support grid economics.
CANDIDATES=("AVAX-USD" "DOGE-USD" "LINK-USD" "MATIC-USD" "DOT-USD" "ATOM-USD")
# Pick one pseudo-randomly based on date so we cycle through the list.
IDX=$(($(date +%j) % ${#CANDIDATES[@]}))
SYMBOL=${CANDIDATES[$IDX]}

echo "[coo-propose] $(date +%H:%M) backtesting grid candidate: $SYMBOL"

# Call backtest service (port 4308). If not available, log + skip.
BT=$(curl -fsS --max-time 30 "http://localhost:4308/backtest?symbol=$SYMBOL&strategy=grid&days=30" 2>/dev/null || echo '{"error":"backtest unavailable"}')
SHARPE=$(echo "$BT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('sharpe','?'))" 2>/dev/null || echo "?")
WR=$(echo "$BT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('winRate','?'))" 2>/dev/null || echo "?")
PNL=$(echo "$BT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('realizedPnl','?'))" 2>/dev/null || echo "?")

OUTPUT_FILE="$DIR/${TS}-${SYMBOL}.md"
{
  echo "# Backtest proposal: $SYMBOL — $TS"
  echo ""
  echo "- Sharpe: $SHARPE"
  echo "- Win rate: ${WR}%"
  echo "- Simulated 30d PnL: \$${PNL}"
  echo ""
  echo "## Raw backtest output"
  echo '```json'
  echo "$BT" | python3 -m json.tool 2>/dev/null || echo "$BT"
  echo '```'
} > "$OUTPUT_FILE"

echo "[coo-propose] wrote $OUTPUT_FILE (Sharpe=$SHARPE WR=$WR PnL=\$$PNL)"

# If the Sharpe is numeric and > 1.0, emit an ops-event so the COO surfaces it.
if [[ "$SHARPE" =~ ^-?[0-9]+\.?[0-9]*$ ]] && (( $(echo "$SHARPE > 1.0" | bc -l) )); then
  EVENTS_FILE=services/api/.runtime/paper-ledger/events.jsonl
  ENTRY=$(python3 -c "
import json
print(json.dumps({
    'timestamp': '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)',
    'type': 'coo-backtest-proposal',
    'source': 'coo-symbol-proposer',
    'severity': 'info',
    'message': 'Candidate $SYMBOL passed backtest: Sharpe=$SHARPE WR=${WR}%% PnL=\$$PNL — COO review recommended',
    'extra': {'symbol': '$SYMBOL', 'sharpe': '$SHARPE', 'winRate': '$WR', 'pnl': '$PNL', 'file': '$OUTPUT_FILE'}
}))
")
  echo "$ENTRY" >> "$EVENTS_FILE"
  echo "[coo-propose] emitted coo-backtest-proposal event (Sharpe $SHARPE > 1.0)"
fi
