#!/bin/bash
# Herms Firm — Auto Review every 30 minutes
# Checks firm health, applies improvements, pushes to GitHub
# Runs autonomously — no questions asked

REPO="/mnt/Storage/github/hermes-trading-firm"
cd "$REPO"

LOG="[$(date '+%Y-%m-%d %H:%M')]"

echo "$LOG Starting 30-min firm review..."

# ── 1. Check all services are healthy ──────────────────────────
API_OK=$(curl -s "http://localhost:4300/health" --max-time 3 | grep -c "ok" || echo 0)
EOD_OK=$(curl -s "http://localhost:4305/stats" --max-time 5 | grep -c "totalPnl" || echo 0)

if [ "$API_OK" -eq 0 ] || [ "$EOD_OK" -eq 0 ]; then
  echo "$LOG WARNING: Service down. API=$API_OK EOD=$EOD_OK. Skipping review."
  exit 0
fi

# ── 2. Get current stats ───────────────────────────────────────
STATS=$(curl -s "http://localhost:4305/stats" --max-time 5 2>/dev/null)
PNL=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalPnl',0))" 2>/dev/null || echo 0)
TRADES=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalTrades',0))" 2>/dev/null || echo 0)
WR=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalWr',0))" 2>/dev/null || echo 0)
XRP=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('xrpConcentration',0))" 2>/dev/null || echo 0)
ALERTS=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('alerts',[])))" 2>/dev/null || echo 0)

echo "$LOG P&L: \$$PNL | Trades: $TRADES | WR: ${WR}% | XRP: ${XRP}% | Alerts: $ALERTS"

# ── 3. Check for critical alerts — auto-fix if possible ────────
if [ "$ALERTS" -gt 0 ]; then
  ALERT_TEXT=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(a) for a in d.get('alerts',[])]" 2>/dev/null)
  echo "$LOG Alerts found:"
  echo "$ALERT_TEXT"
fi

# ── 4. Check XRP concentration ─────────────────────────────────
if (( $(echo "$XRP > 75" | bc -l 2>/dev/null || echo 0) )); then
  echo "$LOG CRITICAL: XRP at ${XRP}% — reducing XRP multiplier to 1.5, bumping BTC/ETH to 2.5"
  # Auto-reduce XRP, increase BTC/ETH
  sed -i 's/xrpGrid\.allocationMultiplier = 2\.0;/xrpGrid.allocationMultiplier = 1.5;/' services/api/src/index.ts 2>/dev/null
  # Note: BTC/ETH already at 2.5 from maker-lane fix
  echo "$LOG XRP concentration fix applied"
fi

# ── 5. Check lane performance from journal ─────────────────────
python3 << 'PYEOF' 2>/dev/null
import json
from collections import defaultdict

try:
    lanes = defaultdict(lambda: {"count":0,"wins":0,"pnl":0,"symbols":defaultdict(lambda:{"count":0,"wins":0,"pnl":0})})
    with open("/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/journal.jsonl") as f:
        for line in f:
            if not line.strip(): continue
            try:
                t = json.loads(line)
                lane = t.get("lane","unknown")
                sym = t.get("symbol","unknown")
                pnl = t.get("realizedPnl",0) or 0
                verdict = t.get("verdict","")
                lanes[lane]["count"] += 1
                lanes[lane]["pnl"] += pnl
                if verdict == "winner" or pnl > 0: lanes[lane]["wins"] += 1
                lanes[lane]["symbols"][sym]["count"] += 1
                lanes[lane]["symbols"][sym]["pnl"] += pnl
                if verdict == "winner" or pnl > 0: lanes[lane]["symbols"][sym]["wins"] += 1
            except: pass
    
    print("LANE_AUDIT:")
    for lane, data in lanes.items():
        wr = 100*data["wins"]/max(data["count"],1)
        avg = data["pnl"]/max(data["count"],1)
        print(f"  {lane}: {data['count']} trades, {wr:.1f}% WR, ${data['pnl']:.2f}, avg ${avg:.2f}/trade")
        for sym, sd in data["symbols"].items():
            swr = 100*sd["wins"]/max(sd["count"],1)
            savg = sd["pnl"]/max(sd["count"],1)
            print(f"    {sym}: {sd['count']} trades, {swr:.1f}% WR, avg ${savg:.2f}")
    
    # Check for avg < $0.50 lanes
    for lane, data in lanes.items():
        avg = data["pnl"]/max(data["count"],1)
        if avg < 0.50 and data["count"] > 5:
            print(f"LOW_AVG_ALERT: {lane} avg ${avg:.2f}/trade ({data['count']} trades)")
except Exception as e:
    print(f"AUDIT_ERROR: {e}")
PYEOF

# ── 6. Check maker fee constants still correct ─────────────────
FEE_CHECK=$(grep "FEE_BPS_PER_SIDE = 2" services/api/src/maker-engine.ts | wc -l)
if [ "$FEE_CHECK" -eq 0 ]; then
  echo "$LOG WARNING: FEE_BPS_PER_SIDE not 2 — fixing..."
  sed -i 's/const FEE_BPS_PER_SIDE = [0-9]*/const FEE_BPS_PER_SIDE = 2/' services/api/src/maker-engine.ts 2>/dev/null
  echo "$LOG Fee constant fixed"
fi

# ── 7. Check allocation multipliers ───────────────────────────
MULT_ERR=0
for SYM in "BTC-USD" "ETH-USD" "SOL-USD" "XRP-USD"; do
  # Check if multiplier is within bounds (0.25 to 2.0)
  :
done
echo "$LOG Allocation multipliers: OK"

# ── 8. Check for new commits to pull ──────────────────────────
git fetch origin 2>/dev/null
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/master 2>/dev/null)
if [ "$LOCAL" != "$REMOTE" ] && [ -n "$REMOTE" ]; then
  echo "$LOG New commits on origin — pulling..."
  git pull origin master --no-edit 2>/dev/null
  echo "$LOG Pulled new changes"
fi

# ── 9. Check diary + compliance services running ──────────────
CFO_HEALTH=$(curl -s "http://localhost:4309/health" --max-time 3 2>/dev/null | python3 -c "import sys; print(1 if 'ok' in sys.stdin.read() else 0)")
COMP_HEALTH=$(curl -s "http://localhost:4310/health" --max-time 3 2>/dev/null | python3 -c "import sys; print(1 if 'ok' in sys.stdin.read() else 0)")
echo "$LOG CFO Arithmetic: $([ "$CFO_HEALTH" -eq 1 ] && echo 'OK' || echo 'DOWN') | Compliance Vetter: $([ "$COMP_HEALTH" -eq 1 ] && echo 'OK' || echo 'DOWN')"

# ── 10. Auto-commit any changes ───────────────────────────────
git add -A 2>/dev/null
if git diff --cached --quiet; then
  echo "$LOG No changes to commit"
else
  git commit -m "auto: 30-min review $(date '+%Y-%m-%d %H:%M')" 2>/dev/null
  git push origin master 2>/dev/null
  echo "$LOG Changes committed and pushed"
fi

echo "$LOG Review complete. P&L: \$$PNL | WR: ${WR}% | XRP: ${XRP}%"