#!/bin/bash
set -e
cd /mnt/Storage/github/hermes-trading-firm
TS=$(date +%Y-%m-%d)
DIR=docs/coo-journal/briefings
mkdir -p "$DIR"

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

SCRIPT_DIR=$(dirname "$0")
bash "$SCRIPT_DIR/_openclaw-call.sh" coo-briefing "$PROMPT_FILE" > "$DIR/${TS}.md"
echo "[coo-briefing] wrote $DIR/${TS}.md"
