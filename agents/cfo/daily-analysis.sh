#!/bin/bash
# Hermes Firm - Pattern Analyzer + Hypothesis Generator
# Runs daily via cron (HERMES_DAILY_ANALYSIS event)
# Philosophy: find the highest-impact fixable problem, generate a specific hypothesis, let the strategy director test it
set -e

REPO="/mnt/Storage/github/hermes-trading-firm"
cd "$REPO"
JOURNAL="$REPO/services/api/.runtime/paper-ledger/journal.jsonl"
HYPOTHESIS_DIR="$REPO/agents/cfo/hypotheses"
MEMORY_FILE="/tmp/cfo-pattern-memory.json"
mkdir -p "$HYPOTHESIS_DIR"

LOG="[$(date '+%Y-%m-%d %H:%M:%S')]"
echo "$LOG Starting daily pattern analysis..."

# Load pattern memory
MEMORY='{"daily":[], "issues":[], "last_run":""}'
[ -f "$MEMORY_FILE" ] && MEMORY=$(cat "$MEMORY_FILE") || true

python3 << 'PYEOF'
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta

MEMORY_FILE = "/tmp/cfo-pattern-memory.json"
JOURNAL = "/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/journal.jsonl"
HYPOTHESIS_DIR = "/mnt/Storage/github/hermes-trading-firm/agents/cfo/hypotheses"

try:
    with open(JOURNAL) as f:
        lines = f.readlines()
except:
    print("JOURNAL_READ_ERROR")
    sys.exit(0)

# Parse all trades
trades = []
for line in lines:
    if not line.strip(): continue
    try:
        t = json.loads(line)
        t['_ts'] = t.get('timestamp', '?')
        trades.append(t)
    except: pass

if len(trades) < 10:
    print("INSUFFICIENT_TRADES")
    sys.exit(0)

today = datetime.now().strftime('%Y-%m-%d')
yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')

# --- 1. LANE PERFORMANCE AUDIT ---
lanes = defaultdict(lambda: {"count":0,"wins":0,"pnl":0.0,"losers":0,"symbols":defaultdict(lambda:{"count":0,"wins":0,"pnl":0.0,"avg_pnl":0})})
regimes = defaultdict(lambda: {"count":0,"pnl":0.0})
symbols_by_lane = defaultdict(lambda: defaultdict(lambda: {"count":0,"wins":0,"pnl":0.0,"avg":0,"rps":[],"losses":[]}))

for t in trades:
    lane = t.get('lane','unknown')
    sym = t.get('symbol','unknown')
    pnl = t.get('realizedPnl', 0) or 0
    verdict = t.get('verdict','')
    regime = t.get('marketRegime','unknown')
    
    lanes[lane]['count'] += 1
    lanes[lane]['pnl'] += pnl
    if verdict == 'winner' or pnl > 0:
        lanes[lane]['wins'] += 1
    else:
        lanes[lane]['losers'] += 1
    lanes[lane]['symbols'][sym]['count'] += 1
    lanes[lane]['symbols'][sym]['pnl'] += pnl
    if verdict == 'winner' or pnl > 0:
        lanes[lane]['symbols'][sym]['wins'] += 1
    lanes[lane]['symbols'][sym]['avg'] = lanes[lane]['symbols'][sym]['pnl'] / max(lanes[lane]['symbols'][sym]['count'],1)
    
    regimes[regime]['count'] += 1
    regimes[regime]['pnl'] += pnl

# --- 2. FIND WORST-PROBLEM-SOLVABLE ISSUES ---
issues = []

# Issue A: Lane avg/trade too low
for lane, data in lanes.items():
    avg = data['pnl'] / max(data['count'],1)
    if data['count'] >= 5 and avg < 0.30:
        issues.append({
            "type": "LOW_AVG_TRADE",
            "lane": lane,
            "count": data['count'],
            "avg": round(avg,3),
            "pnl": round(data['pnl'],2),
            "wr": round(100*data['wins']/max(data['count'],1),1),
            "severity": "HIGH" if avg < 0 else "MEDIUM",
            "fix": "Consider disabling lane or changing sizing/fees"
        })
        print(f"ISSUE: {lane} avg ${avg}/trade over {data['count']} trades (WR {100*data['wins']/max(data['count'],1):.0f}%)")

# Issue B: Losing streak detection
syms = defaultdict(lambda: {"count":0,"pnl":0.0,"rps":[],"last_ts":"?","losses":0})
for t in trades:
    sym = t.get('symbol','unknown')
    pnl = t.get('realizedPnl',0) or 0
    syms[sym]['count'] += 1
    syms[sym]['pnl'] += pnl
    syms[sym]['last_ts'] = t.get('timestamp','?')
    if pnl < 0: syms[sym]['losses'] += 1
    syms[sym]['rps'].append(pnl)

for sym, data in syms.items():
    if data['count'] < 3: continue
    # Check for consecutive losers
    rps = data['rps'][-10:]
    consec = 0
    for rp in reversed(rps):
        if rp < 0: consec += 1
        else: break
    if consec >= 4 and data['losses']/max(data['count'],1) > 0.5:
        issues.append({
            "type": "CONSECUTIVE_LOSSES",
            "symbol": sym,
            "consec_losses": consec,
            "total_trades": data['count'],
            "loss_rate": round(100*data['losses']/max(data['count'],1),1),
            "severity": "HIGH",
            "fix": "Pause symbol or adjust entry regime filter"
        })
        print(f"ISSUE: {sym} {consec} consecutive losses, {data['losses']}/{data['count']} total losses")

# Issue C: Regime performance
for regime, data in regimes.items():
    if data['count'] < 5: continue
    avg = data['pnl'] / max(data['count'],1)
    if avg < -0.20:
        issues.append({
            "type": "BAD_REGIME",
            "regime": regime,
            "count": data['count'],
            "avg": round(avg,3),
            "pnl": round(data['pnl'],2),
            "severity": "HIGH",
            "fix": f"Reduce {regime} exposure or adjust spread sizing"
        })
        print(f"ISSUE: Regime {regime} avg ${avg}/trade ({data['count']} trades)")

# Issue D: XRP concentration structural (flag if BTC/ETH still < 20 trades each)
btc_count = lanes['grid']['symbols'].get('BTC-USD',{}).get('count',0)
eth_count = lanes['grid']['symbols'].get('ETH-USD',{}).get('count',0)
sol_count = lanes['grid']['symbols'].get('SOL-USD',{}).get('count',0)
xrp_count = lanes['grid']['symbols'].get('XRP-USD',{}).get('count',0)
total_grid = btc_count + eth_count + sol_count + xrp_count
if total_grid > 0:
    xrp_pct = 100 * xrp_count / max(total_grid,1)
    if xrp_pct > 70 and (btc_count < 30 or eth_count < 30):
        issues.append({
            "type": "XRP_CONCENTRATION_STRUCTURAL",
            "xrp_pct": round(xrp_pct,1),
            "btc_trades": btc_count,
            "eth_trades": eth_count,
            "sol_trades": sol_count,
            "xrp_trades": xrp_count,
            "severity": "HIGH",
            "fix": "BTC/ETH/SOL grids need volume growth to dilute XRP. Boost allocation or widen spreads on BTC/ETH."
        })
        print(f"ISSUE: XRP structural concentration {xrp_pct:.0f}% (BTC={btc_count} ETH={eth_count} SOL={sol_count})")

# --- 3. TOP OPPORTUNITY ---
# Find symbol with best avg but lowest trade count — increase allocation there
opportunities = []
for lane, data in lanes.items():
    for sym, sdata in data['symbols'].items():
        if sdata['count'] >= 5:
            avg = sdata['pnl'] / max(sdata['count'],1)
            wr = 100 * sdata['wins'] / max(sdata['count'],1)
            if avg > 0.50 and wr > 55:
                opportunities.append({
                    "symbol": sym,
                    "lane": lane,
                    "count": sdata['count'],
                    "avg": round(avg,3),
                    "wr": round(wr,1),
                    "potential": round(avg * 10, 2)  # potential if we did 10 more trades
                })

opportunities.sort(key=lambda x: -x['potential'])
if opportunities:
    top = opportunities[0]
    print(f"OPPORTUNITY: {top['symbol']} avg ${top['avg']}/trade WR {top['wr']}% — potential +${top['potential']}/10 more trades")

# --- 4. GENERATE HYPOTHESIS FILE ---
if issues:
    top_issue = sorted(issues, key=lambda x: {"HIGH":0,"MEDIUM":1}.get(x.get('severity','MEDIUM'),2))[0]
    hypothesis = {
        "id": f"hypo-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
        "date": datetime.now().isoformat(),
        "issue": top_issue,
        "opportunity": opportunities[0] if opportunities else None,
        "lane_stats": {lane: {"count":d["count"],"wins":d["wins"],"pnl":round(d["pnl"],2),"avg":round(d["pnl"]/max(d["count"],1),3)} for lane,d in lanes.items()},
        "regime_stats": {reg: {"count":d["count"],"pnl":round(d["pnl"],2)} for reg,d in regimes.items()},
        "total_trades": len(trades)
    }
    hypo_file = f"{HYPOTHESIS_DIR}/hypothesis-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(hypo_file, 'w') as f:
        json.dump(hypothesis, f, indent=2)
    print(f"HYPOTHESIS_WRITTEN: {hypo_file}")
    print(f"TOP ISSUE: {top_issue['type']} on {top_issue.get('lane', top_issue.get('symbol', top_issue.get('regime','?')))}")
else:
    print("NO_CRITICAL_ISSUES_FOUND")

# Update pattern memory
try:
    with open(MEMORY_FILE) as f:
        mem = json.load(f)
except:
    mem = {"daily":[],"issues":[],"last_run":""}

mem["last_run"] = datetime.now().isoformat()
mem["daily"].append({
    "date": today,
    "total_trades": len(trades),
    "top_issue": issues[0] if issues else None,
    "opportunity": opportunities[0] if opportunities else None
})
if len(mem["daily"]) > 30: mem["daily"] = mem["daily"][-30:]
mem["issues"].extend(issues)
if len(mem["issues"]) > 100: mem["issues"] = mem["issues"][-100:]

with open(MEMORY_FILE, 'w') as f:
    json.dump(mem, f, indent=2)
print("PATTERN_MEMORY_UPDATED")

except Exception as e:
    print(f"ANALYSIS_ERROR: {e}")
    import traceback; traceback.print_exc()
PYEOF

echo "$LOG Daily analysis complete"
