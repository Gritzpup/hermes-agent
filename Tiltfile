# Each service watches ONLY its own src/package.json. The shared
# `packages/contracts/src` is imported by all of them, but every service
# already runs `tsx watch` which follows imports and hot-reloads the process
# on contract changes. Keeping contracts in Tilt deps caused full-fleet
# cascade restarts on any contract edit, producing EADDRINUSE races and
# killing broker-router + web repeatedly during normal iteration.

# ============================================
# OPENCLAW - Hermes Trading Firm Agent
# Background tasks, cron jobs, autonomous agent actions
# ============================================

local_resource(
    'openclaw-hermes',
    serve_cmd='npm run dev:openclaw-hermes',
    deps=['services/openclaw-hermes/src', 'services/openclaw-hermes/package.json'],
    labels=['agents'],
    readiness_probe=probe(
        period_secs=10,
        initial_delay_secs=5,
        http_get=http_get_action(port=4395, path='/health')
    ),
    auto_init=False,
    trigger_mode=TRIGGER_MODE_AUTO
)

local_resource(
    'hermes-broker-router',
    serve_cmd='npm run dev:broker-router',
    deps=['services/broker-router/src', 'services/broker-router/package.json'],
    labels=['core'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4303, path='/health')
    ),
    auto_init=True,
    trigger_mode=TRIGGER_MODE_AUTO
)

# ============================================
# Hermes Trading Firm — Tilt-managed services
# Broker-router now runs as a separate Tilt-managed resource (port 4303).

local_resource(
    'hermes-api',
    serve_cmd='npm run dev:api',
    deps=['services/api/src', 'services/api/package.json'],
    resource_deps=['hermes-market-data', 'hermes-risk-engine', 'hermes-broker-router', 'hermes-backtest'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4300, path='/health')
    ),
    labels=['core'],
    auto_init=False
)

local_resource(
    'hermes-market-data',
    serve_cmd='npm run dev:market-data',
    deps=['services/market-data/src', 'services/market-data/package.json'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4302, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-risk-engine',
    serve_cmd='npm run dev:risk-engine',
    deps=['services/risk-engine/src', 'services/risk-engine/package.json'],
    resource_deps=['hermes-market-data'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4301, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-notifier',
    serve_cmd='npm run dev:notifier',
    deps=['services/notifier/src', 'services/notifier/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4312, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-review-loop',
    serve_cmd='npm run dev:review-loop',
    deps=['services/review-loop/src', 'services/review-loop/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4304, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-eod-analysis',
    serve_cmd='npm run dev:eod-analysis',
    deps=['services/eod-analysis/src', 'services/eod-analysis/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4305, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)

local_resource(
    'hermes-daily-diary',
    serve_cmd='npm run dev:diary',
    deps=['services/daily-diary/src', 'services/daily-diary/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4307, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)

local_resource(
    'hermes-backtest',
    serve_cmd='npm run dev:backtest',
    deps=['services/backtest/src', 'services/backtest/package.json'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4308, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-strategy-lab',
    serve_cmd='npm run dev:strategy-lab',
    deps=['services/strategy-lab/src', 'services/strategy-lab/package.json'],
    resource_deps=['hermes-backtest'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4306, path='/health')
    ),
    labels=['core']
)

local_resource(
    'hermes-research-agent',
    serve_cmd='npm run dev:research-agent',
    deps=['services/research-agent/src', 'services/research-agent/package.json'],
    resource_deps=['hermes-market-data'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4310, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)

local_resource(
    'hermes-risk-agent',
    serve_cmd='npm run dev:risk-agent',
    deps=['services/risk-agent/src', 'services/risk-agent/package.json'],
    resource_deps=['hermes-risk-engine', 'hermes-broker-router'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4311, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)

local_resource(
    'hermes-exec-agent',
    serve_cmd='npm run dev:exec-agent',
    deps=['services/exec-agent/src', 'services/exec-agent/package.json'],
    resource_deps=['hermes-broker-router'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4312, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)

# ============================================
# Self-Improve — Autonomous Archon loop
# Runs state→act→dashboard→archon→commit every 15 min.
# Tilt-managed — auto-restarts on crash or file change.
# ============================================

local_resource(
    'hermes-self-improve',
    serve_cmd='cd /mnt/Storage/github/hermes-trading-firm && npx tsx watch services/self-improve/src/index.ts',
    deps=['services/self-improve/src', 'services/self-improve/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=10,
        initial_delay_secs=5,
        http_get=http_get_action(port=4313, path='/health')
    ),
    labels=['agents'],
    auto_init=True
)

# ============================================
# CFO — Arithmetic, Finance oversight agent
# Runs every 6 hours. Reads journal.jsonl. Posts alerts + reports.
# ============================================

local_resource(
    'hermes-cfo',
    serve_cmd='cd /mnt/Storage/github/hermes-trading-firm && npm run dev:cfo',
    env={'HERMES_LEDGER_DIR': '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger'},
    deps=['services/cfo/src', 'services/cfo/package.json'],
    resource_deps=['hermes-api', 'openclaw-hermes'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4309, path='/health')
    ),
    labels=['agents'],
    auto_init=True
)

# ============================================
# Vetter — Compliance Officer
# Runs every 6 hours. Synthetic detection, quarantine audit,
# XRP concentration, drawdown limits, allocation audit, fee validation.
# ============================================

local_resource(
    'hermes-compliance',
    serve_cmd='npm run dev:compliance',
    deps=['services/compliance/src', 'services/compliance/package.json'],
    resource_deps=['hermes-api'],
    readiness_probe=probe(
        period_secs=5,
        initial_delay_secs=3,
        http_get=http_get_action(port=4310, path='/health')
    ),
    labels=['agents'],
    auto_init=False
)
# hermes-vision — desktop screenshot analysis via Kimi vision
local_resource(
  'hermes-vision',
  serve_cmd='npm run dev:vision',
  deps=['services/vision/src'],
  resource_deps=[],
  readiness_probe=probe(http_get=http_get_action(port=4311, path='/health'), period_secs=10, timeout_secs=5, failure_threshold=3),
  labels=['agents']
)


