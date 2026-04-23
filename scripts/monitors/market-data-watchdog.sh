#!/usr/bin/env bash
# Market Data Watchdog
# Polls hermes-market-data health endpoint and restarts via tilt if unhealthy.

HEALTH_URL="http://localhost:4302/health"
LOG_FILE="/mnt/Storage/github/hermes-trading-firm/services/.runtime/market-data-watchdog.log"
CONSECUTIVE_FAILURES=0
MAX_FAILURES=3
REPO_DIR="/mnt/Storage/github/hermes-trading-firm"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"
}

log "Market-data watchdog started. Polling ${HEALTH_URL} every 30s."

while true; do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        if [ "$CONSECUTIVE_FAILURES" -gt 0 ]; then
            log "Health check passed after ${CONSECUTIVE_FAILURES} failure(s)."
            CONSECUTIVE_FAILURES=0
        fi
    else
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        log "Health check FAILED (attempt ${CONSECUTIVE_FAILURES}/${MAX_FAILURES})."

        if [ "$CONSECUTIVE_FAILURES" -ge "$MAX_FAILURES" ]; then
            log "RESTARTING hermes-market-data via tilt..."
            cd "$REPO_DIR" || { log "ERROR: failed to cd to ${REPO_DIR}"; sleep 30; continue; }
            if tilt disable hermes-market-data >> "$LOG_FILE" 2>&1; then
                log "tilt disable hermes-market-data: OK"
            else
                log "tilt disable hermes-market-data: FAILED"
            fi
            if tilt enable hermes-market-data >> "$LOG_FILE" 2>&1; then
                log "tilt enable hermes-market-data: OK"
            else
                log "tilt enable hermes-market-data: FAILED"
            fi
            log "Restart sequence complete. Resetting failure counter."
            CONSECUTIVE_FAILURES=0
        fi
    fi

    sleep 30
done
