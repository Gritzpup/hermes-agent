#!/bin/bash
# COO daily retrospective: runs the main openclaw agent in a dedicated session
# to review the last 24h of actions + outcomes and write a scored retro.
# Invoked by the tilt resource `coo-retrospective` every 24h.

set -e
cd /mnt/Storage/github/hermes-trading-firm

TS=$(date +%Y-%m-%d)
RETRO_DIR=docs/coo-journal/retros
RT=services/openclaw-hermes/.runtime
OPENCLAW=/home/ubuntubox/.npm-global/bin/openclaw

mkdir -p "$RETRO_DIR"

ACTIONS="[]"
if [ -s "$RT/coo-actions.log" ]; then
  ACTIONS=$(tail -200 "$RT/coo-actions.log")
fi

OUTCOMES="[]"
if [ -s "$RT/coo-outcomes.jsonl" ]; then
  OUTCOMES=$(tail -50 "$RT/coo-outcomes.jsonl")
fi

PROMPT_FILE=$(mktemp)
trap "rm -f $PROMPT_FILE" EXIT

cat > "$PROMPT_FILE" <<PROMPT_EOF
You are the hermes COO performing a scheduled retrospective.

Review the last 24h of your actions and the firm-state outcomes captured at each action.
Score each consequential decision: did it correlate with P&L improvement? What pattern
would you change going forward?

Output valid markdown with these exact sections:
# Retrospective ${TS}
## Summary
(one paragraph)
## Wins
(bulleted list of decisions that helped)
## Losses
(bulleted list of decisions that hurt or didn't help)
## Patterns
(observations across multiple decisions)
## Next-24h Plan
(what you'll prioritize or change)

DATA:

ACTIONS_LOG:
${ACTIONS}

OUTCOMES:
${OUTCOMES}
PROMPT_EOF

echo "[coo-retro] $(date +%H:%M) generating retro for ${TS}..."

SCRIPT_DIR=$(dirname "$0")
bash "$SCRIPT_DIR/_openclaw-call.sh" coo-retro "$PROMPT_FILE" > "$RETRO_DIR/${TS}.md"

echo "[coo-retro] retro written to $RETRO_DIR/${TS}.md"
