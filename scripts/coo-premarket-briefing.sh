#!/bin/bash
set -e
cd /mnt/Storage/github/hermes-trading-firm
TS=$(date +%Y-%m-%d)
DIR=docs/coo-journal/briefings
mkdir -p "$DIR"
OPENCLAW=/home/ubuntubox/.npm-global/bin/openclaw

# Pull context
CAL=$(curl -fsS --max-time 5 http://localhost:4300/api/calendar 2>/dev/null || echo "[]")
PNL=$(curl -fsS --max-time 5 http://localhost:4300/api/pnl-attribution 2>/dev/null || echo "{}")
DESK=$(curl -fsS --max-time 5 http://localhost:4300/api/paper-desk 2>/dev/null || echo "{}")
SAFETY=$(curl -fsS --max-time 5 http://localhost:4300/api/live-safety 2>/dev/null || echo "{}")

PROMPT_FILE=$(mktemp)
trap "rm -f $PROMPT_FILE" EXIT
cat > "$PROMPT_FILE" <<PROMPT_EOF
You are the hermes COO producing a pre-market briefing for ${TS}.

Review today's calendar, open positions, firm P&L, and safety status. Output VALID markdown with exactly these sections:
# Pre-Market Briefing ${TS}
## Calendar Events Today
## Open Risk Flags
## Portfolio Snapshot
## Watchlist (what to monitor)
## Recommended Adjustments

DATA:
CALENDAR:
${CAL}

PNL_ATTRIBUTION:
${PNL}

DESK:
${DESK}

SAFETY:
${SAFETY}
PROMPT_EOF

echo "[coo-briefing] $(date +%H:%M) generating briefing for ${TS}..."
RAW=$("$OPENCLAW" agent --local --thinking medium --session-id coo-briefing --json -m "$(cat "$PROMPT_FILE")" 2>&1)
echo "$RAW" | python3 -c '
import json, re, sys
raw = sys.stdin.read()
raw = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw)
m = re.search(r"\{[\s\S]*\}", raw)
env = json.loads(m.group(0)) if m else {}
p = env.get("payloads", [])
if p and isinstance(p, list) and p[0].get("text"):
    print(p[0]["text"])
elif env.get("reply"):
    print(env["reply"])
else:
    print("(no response)")
' > "$DIR/${TS}.md"
echo "[coo-briefing] wrote $DIR/${TS}.md"
