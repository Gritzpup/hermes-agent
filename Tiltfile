local_resource(
    'hermes-api',
    serve_cmd='npm run dev:api',
    deps=['services/api/src', 'packages/contracts/src', 'services/api/package.json'],
    resource_deps=['hermes-market-data', 'hermes-broker-router', 'hermes-risk-engine']
)

local_resource(
    'hermes-market-data',
    serve_cmd='npm run dev:market-data',
    deps=['services/market-data/src', 'packages/contracts/src', 'services/market-data/package.json']
)

local_resource(
    'hermes-risk-engine',
    serve_cmd='npm run dev:risk-engine',
    deps=['services/risk-engine/src', 'packages/contracts/src', 'services/risk-engine/package.json']
)

local_resource(
    'hermes-broker-router',
    serve_cmd='npm run dev:broker-router',
    deps=['services/broker-router/src', 'packages/contracts/src', 'services/broker-router/package.json'],
    resource_deps=['hermes-risk-engine']
)

local_resource(
    'hermes-review-loop',
    serve_cmd='npm run dev:review-loop',
    deps=['services/review-loop/src', 'packages/contracts/src', 'services/review-loop/package.json']
)

local_resource(
    'hermes-backtest',
    serve_cmd='npm run dev:backtest',
    deps=['services/backtest/src', 'packages/contracts/src', 'services/backtest/package.json']
)

local_resource(
    'hermes-strategy-lab',
    serve_cmd='npm run dev:strategy-lab',
    deps=['services/strategy-lab/src', 'packages/contracts/src', 'services/strategy-lab/package.json'],
    resource_deps=['hermes-backtest']
)

local_resource(
    'hermes-web',
    serve_cmd='npm run dev:web',
    deps=['apps/web/src', 'packages/contracts/src', 'apps/web/package.json'],
    resource_deps=['hermes-api']
)
