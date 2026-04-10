# Hermes Trading Firm

Hermes Trading Firm is a SvelteKit-based operator cockpit plus a Node/TypeScript service stack for paper-first multi-asset trading.

## Workspace Layout

- `apps/web` - SvelteKit cockpit
- `packages/contracts` - shared domain contracts and seeded mock data
- `services/api` - control plane API for the cockpit
- `services/market-data` - normalized market data service skeleton
- `services/risk-engine` - hard-limit and kill-switch service skeleton
- `services/broker-router` - venue routing service skeleton
- `services/review-loop` - trade journal and review pipeline skeleton
- `docs` - legacy snapshot and migration notes
- `scripts` - operational scripts, including legacy Hermes shutdown

## Quick Start

```bash
npm install
npm run dev
```

The web cockpit runs on `http://localhost:4173` and the control API runs on `http://localhost:4300`.

## Current Status

This repo is the clean extraction point from the old Hermes Trading Post. The initial implementation includes:

- dedicated SvelteKit cockpit routes
- normalized contracts for market, order, risk, review, and settings data
- service skeletons for broker routing, risk, review, and market data
- legacy snapshot docs and a script to disable the old Hermes Tilt resources

## Legacy Shutdown

Run the new script once you're ready to turn off the old Hermes stack:

```bash
./scripts/shutdown-legacy-hermes.sh
```
