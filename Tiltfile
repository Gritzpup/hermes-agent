# Each service watches ONLY its own src/package.json. The shared
# `packages/contracts/src` is imported by all of them, but every service
# already runs `tsx watch` which follows imports and hot-reloads the process
# on contract changes. Keeping contracts in Tilt deps caused full-fleet
# cascade restarts on any contract edit, producing EADDRINUSE races and
# killing broker-router + web repeatedly during normal iteration.

local_resource(
    'hermes-api',
    serve_cmd='npm run build && npm run start:prod',
    deps=['services/api/src', 'services/api/package.json'],
    resource_deps=['hermes-market-data', 'hermes-broker-router', 'hermes-risk-engine']
)

local_resource(
    'hermes-market-data',
    serve_cmd='npm run dev:market-data',
    deps=['services/market-data/src', 'services/market-data/package.json']
)

local_resource(
    'hermes-risk-engine',
    serve_cmd='npm run dev:risk-engine',
    deps=['services/risk-engine/src', 'services/risk-engine/package.json']
)

local_resource(
    'hermes-broker-router',
    serve_cmd='npm run dev:broker-router',
    deps=['services/broker-router/src', 'services/broker-router/package.json'],
    resource_deps=['hermes-risk-engine']
)

local_resource(
    'hermes-review-loop',
    serve_cmd='npm run dev:review-loop',
    deps=['services/review-loop/src', 'services/review-loop/package.json']
)

local_resource(
    'hermes-backtest',
    serve_cmd='npm run dev:backtest',
    deps=['services/backtest/src', 'services/backtest/package.json']
)

local_resource(
    'hermes-strategy-lab',
    serve_cmd='npm run dev:strategy-lab',
    deps=['services/strategy-lab/src', 'services/strategy-lab/package.json'],
    resource_deps=['hermes-backtest']
)

local_resource(
    'hermes-web',
    serve_cmd='npm run dev:web',
    deps=['apps/web/src', 'apps/web/package.json'],
    resource_deps=['hermes-api']
)
