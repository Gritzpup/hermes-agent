#!/bin/bash
# Shared helper: invoke openclaw agent with a prompt file, extract payloads[0].text
# from the response envelope, print to stdout. Used by coo-retro + coo-briefing.
#
# Args: $1 = session-id, $2 = prompt file path
# Env:  OPENCLAW (default /home/ubuntubox/.npm-global/bin/openclaw)
#       THINKING (default medium)

OPENCLAW=${OPENCLAW:-/home/ubuntubox/.npm-global/bin/openclaw}
THINKING=${THINKING:-medium}
SESSION="$1"
PROMPT_FILE="$2"

if [ -z "$SESSION" ] || [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
    echo "(openclaw-call: missing args or prompt file)" >&2
    exit 1
fi

RAW=$("$OPENCLAW" agent --local --thinking "$THINKING" --session-id "$SESSION" --json \
      -m "$(cat "$PROMPT_FILE")" 2>&1)

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
'
