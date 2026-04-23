#!/usr/bin/env bash
#
# lessons-learned.sh — Summarise the most recent Hermes session into feedback memory.
#
# Uses Kimi (via hermes chat --provider kimi) instead of the deprecated MiniMax path.

set -euo pipefail

for cmd in hermes jq date; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: '$cmd' not found in PATH" >&2; exit 1; }
done

SESSIONS_DIR="${HOME}/.hermes/sessions"
MEMORY_DIR="/home/ubuntubox/.claude/projects/-home-ubuntubox/memory"
MEMORY_IDX="${MEMORY_DIR}/MEMORY.md"

newest=$(find "$SESSIONS_DIR" -maxdepth 1 -name 'session_*.json' -type f \
  -printf '%T+\t%p\n' 2>/dev/null \
  | sort -r \
  | head -1 \
  | cut -f2)

if [[ -z "$newest" ]]; then
  echo "ERROR: no session_*.json found in $SESSIONS_DIR" >&2
  exit 1
fi

session_basename=$(basename "$newest" .json)
marker="${SESSIONS_DIR}/.lessons-done-${session_basename}"

if [[ -f "$marker" ]]; then
  echo "SKIP: session already summarised (marker exists: $marker)"
  exit 0
fi

transcript=$(jq -r '
  .messages[] |
  select(.role == "assistant") |
  .content // empty
' "$newest" 2>/dev/null | tail -c 12000)

if [[ -z "$transcript" || "$transcript" == "null" ]]; then
  echo "WARN: no assistant messages found in $newest — skipping summarisation" >&2
  exit 0
fi

timestamp=$(date +%Y%m%d_%H%M)
memory_file="${MEMORY_DIR}/lesson_${timestamp}.md"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "=== DRY RUN — would write to: $memory_file ==="
  echo "--- frontmatter (would write) ---"
  echo "---"
  echo "name: lesson-${timestamp}"
  echo "description: Auto-generated feedback from session ${session_basename}"
  echo "type: feedback"
  echo "---"
  echo "--- body (would write, 400-word limit) ---"
fi

PROMPT="You are a concise retro analyst. Read the following Hermes agent session
transcript and produce a structured summary in three sections (under 400 words total):

## What Worked
Bullet points of approaches, commands, or decisions that succeeded.

## What Surprised Us
Unexpected outcomes, surprising model behaviour, or unintended side-effects.

## What to Avoid
Actions, patterns, or habits that caused problems, confusion, or regressions.

Be specific and actionable. Do not invent information not present in the transcript.

---
TRANSCRIPT (excerpt):
${transcript:0:8000}
"

summary=$(
  hermes chat \
    --provider kimi \
    -m kimi-k2.5 \
    --yolo \
    -q "$PROMPT" 2>/dev/null
)

if [[ -z "$summary" ]]; then
  echo "ERROR: hermes chat returned empty output" >&2
  exit 1
fi

frontmatter="---
name: lesson-${timestamp}
description: Auto-generated feedback from session ${session_basename}
type: feedback
---"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "$frontmatter"
  echo ""
  echo "$summary"
  echo ""
  echo "=== DRY RUN — would also append index entry to: $MEMORY_IDX ==="
  echo "- [lesson-${timestamp}] \
(${memory_file}) — summary of ${session_basename}"
  echo "=== DRY RUN complete ==="
  exit 0
fi

mkdir -p "$MEMORY_DIR"
cat > "$memory_file" <<EOF
${frontmatter}

${summary}
EOF

index_line="- [lesson-${timestamp}] \
(${memory_file}) — summary of ${session_basename}"

if grep -q "^## Feedback" "$MEMORY_IDX"; then
  sed -i "/^## Feedback/a $index_line" "$MEMORY_IDX"
else
  echo -e "\n## Feedback" >> "$MEMORY_IDX"
  echo "$index_line" >> "$MEMORY_IDX"
fi

touch "$marker"

echo "DONE: wrote $memory_file  |  indexed in $MEMORY_IDX  |  stamped $marker"
