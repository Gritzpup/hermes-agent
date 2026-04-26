#!/bin/bash
# coo-improvement-watcher: tails the firm event stream for
# `coo-improvement-request` events emitted by the COO via write-event, and
# creates GitHub issues for each one. This closes the COO's self-heal loop —
# the agent can't edit code, but it can surface a labeled, deduplicated issue
# that pi or a human resolves out-of-band.
#
# Shape expected (body sent by the COO):
#   { "severity": "low|medium|high|critical",
#     "area": "bridge|api|market-data|monitor|ci|docs",
#     "description": "...",
#     "suggested_fix": "...",
#     "evidence": [...] }
#
# Dedup: the watcher hashes (area + description) and skips if it has seen that
# hash in the last 24 h (tracked in .runtime/coo-improvements-seen.log).

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/_common.sh"

REPO_ROOT=/mnt/Storage/github/hermes-trading-firm
EVENTS_FILE="$REPO_ROOT/services/api/.runtime/paper-ledger/events.jsonl"
RUNTIME_DIR="$REPO_ROOT/services/openclaw-hermes/.runtime"
SEEN_LOG="$RUNTIME_DIR/coo-improvements-seen.log"
SLEEP_SEC=300  # 5 min between scans
LOG_PREFIX="[coo-improvement-watcher]"

mkdir -p "$RUNTIME_DIR"
touch "$SEEN_LOG"

# Track last scanned byte offset so we don't re-read the whole file each pass.
OFFSET_FILE="$RUNTIME_DIR/coo-improvement-offset"
[ -f "$OFFSET_FILE" ] || echo 0 > "$OFFSET_FILE"

scan_once() {
  [ -s "$EVENTS_FILE" ] || return 0

  local file_size
  file_size=$(stat -c %s "$EVENTS_FILE" 2>/dev/null)
  local last_offset
  last_offset=$(cat "$OFFSET_FILE" 2>/dev/null)
  last_offset=${last_offset:-0}

  # If the file got smaller (rotation / truncation), restart from 0.
  [ "$file_size" -lt "$last_offset" ] && last_offset=0

  if [ "$file_size" -eq "$last_offset" ]; then
    return 0
  fi

  # Read only the new tail slice.
  local new_slice
  new_slice=$(tail -c +$((last_offset + 1)) "$EVENTS_FILE" 2>/dev/null)
  echo "$file_size" > "$OFFSET_FILE"

  # Filter for coo-improvement-request events and create issues.
  # Heredoc delimiter is QUOTED ('PYEOF') so bash doesn't try to interpret any
  # backticks, $vars, or command-substitution inside the Python block. Bash
  # values are passed via env vars (SEEN_LOG, LOG_PREFIX) below.
  echo "$new_slice" | SEEN_LOG="$SEEN_LOG" LOG_PREFIX="$LOG_PREFIX" python3 <<'PYEOF'
import json, os, sys, hashlib, subprocess, time, pathlib

SEEN_LOG = pathlib.Path(os.environ["SEEN_LOG"])
LOG_PREFIX = os.environ.get("LOG_PREFIX", "[coo-improvement-watcher]")
seen = set()
now = int(time.time())
# Prune entries older than 24 h.
if SEEN_LOG.exists():
    fresh = []
    for line in SEEN_LOG.read_text().splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        try:
            ts = int(parts[0])
        except ValueError:
            continue
        if now - ts < 86400:
            fresh.append(line)
            seen.add(parts[1])
    SEEN_LOG.write_text("\n".join(fresh) + ("\n" if fresh else ""))

created = 0
for raw in sys.stdin.read().splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        ev = json.loads(raw)
    except Exception:
        continue
    if ev.get("source") != "coo-improvement-request" and ev.get("eventType") != "coo-improvement-request":
        continue
    body = ev.get("payload") or ev.get("body") or {}
    area = body.get("area", "unknown")
    severity = body.get("severity", "medium")
    desc = body.get("description", "(no description)")
    fix = body.get("suggested_fix", "")
    evidence = body.get("evidence", [])
    key = hashlib.sha1(f"{area}|{desc}".encode()).hexdigest()[:12]

    if key in seen:
        continue

    title = f"[COO improvement] {area}: {desc[:80]}"
    body_md = f"""**Severity:** {severity}
**Area:** {area}
**Requested by:** COO (openclaw-hermes bridge)
**Timestamp:** {ev.get('timestamp', 'unknown')}

## Symptom
{desc}

## Suggested fix
{fix or '(COO did not propose a fix — please triage.)'}

## Evidence
{chr(10).join('- ' + str(e) for e in evidence) if evidence else '(no specific events cited)'}

---
_This issue was auto-created by `scripts/monitors/coo-improvement-watcher.sh` from a
COO `write-event` with `eventType: "coo-improvement-request"`. Deduplicated by
area+description hash for 24 h._
"""

    labels = f"coo-improvement,{severity},{area}"
    try:
        result = subprocess.run(
            ["gh", "issue", "create", "--repo", "Gritzpup/hermes-trading-firm",
             "--title", title, "--body", body_md, "--label", labels],
            capture_output=True, text=True, timeout=30, cwd="/mnt/Storage/github/hermes-trading-firm"
        )
        if result.returncode == 0:
            print(f"{LOG_PREFIX} created: {result.stdout.strip()}")
            with SEEN_LOG.open("a") as f:
                f.write(f"{now} {key}\n")
            created += 1
        else:
            print(f"{LOG_PREFIX} gh issue create failed: {result.stderr.strip()[:200]}")
    except Exception as e:
        print(f"{LOG_PREFIX} exception creating issue: {e}")

if created:
    print(f"{LOG_PREFIX} created {created} issue(s)")
PYEOF
}

echo "$LOG_PREFIX $(date +%H:%M:%S) starting; scanning $EVENTS_FILE every ${SLEEP_SEC}s"

while true; do
  scan_once
  sleep "$SLEEP_SEC"
done
