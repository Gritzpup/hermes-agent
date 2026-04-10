#!/usr/bin/env bash
set -euo pipefail

echo 'Disabling legacy Hermes Tilt resources...'
tilt disable hermes-trading-post hermes-backend paper-bots live-bots paper-ai-bots live-ai-bots hermes-redis-server

echo 'Legacy Hermes resources disabled.'
