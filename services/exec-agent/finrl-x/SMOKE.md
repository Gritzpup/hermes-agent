# FinRL-X Smoke Test Guide

This document verifies the FinRL-X scaffold is wired correctly end-to-end.

---

## Prerequisites

```bash
# Install Python deps (creates .venv in finrl-x/)
cd services/exec-agent/finrl-x
uv venv .venv --python 3.12
uv pip install -e ".[dev]"
```

## Step 1 — Smoke train + ONNX export

```bash
cd services/exec-agent/finrl-x
HERMES_FINRL_SMOKE=1 .venv/bin/python -m finrl_x.train
```

Expected output:
- `[finrl-x][smoke] HERMES_FINRL_SMOKE=1 — running minimal harness check`
- PPO trains for ~100 steps on a synthetic sine-wave environment
- ONNX policy exported to `finrl_x/out/policy.onnx`
- `[finrl-x] ✅ Smoke test PASSED in <2min`
- `[finrl-x] Start inference server: python -m finrl_x.serve --policy <path> --port 7410`

## Step 2 — Start inference server

```bash
cd services/exec-agent/finrl-x
.venv/bin/python -m finrl_x.serve --policy finrl_x/out/policy.onnx --port 7410
```

Verify it's up:
```bash
curl http://127.0.0.1:7410/health
# → {"status":"ok","model":".../policy.onnx","port":7410}
```

Test the edge_score endpoint:
```bash
curl -s -X POST http://127.0.0.1:7410/edge_score \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC-USD","side":"long","price":100.0,"book_imb":0.2,"position":0,"cash":10000}'
# → {"edge_score":0.xxxx,...}
```

## Step 3 — Run pytest suite

```bash
cd services/exec-agent/finrl-x
.venv/bin/python -m pytest finrl_x/__tests__/ -v
# → 17 passed
```

## Step 4 — Verify shadow log (TS)

```bash
# Start exec-agent with HERMES_FINRL_SHADOW=on
HERMES_FINRL_SHADOW=on pnpm --filter @hermes/exec-agent run dev &
sleep 2

# Post a shadow decision
curl -s -X POST http://localhost:4312/api/finrl/record-shadow \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC-USD","ruleBasedAction":"market_buy","price":100.0,"bookImb":0.2,"position":0,"cash":10000,"recommendedEdgeScore":0.75}'

# Check shadow status
curl http://localhost:4312/api/finrl/status
# → {"shadowEnabled":true,"finrlServerUp":false,...}
```

## 14-Day Shadow Window

The shadow log is the **gating fixture** before any live promotion:

| Phase | Duration | Purpose |
|-------|----------|---------|
| Shadow | 14 days  | Collect rule-based vs RL decision pairs in Redis |
| Phase 5 backtest | operator-driven | Replay shadow log, compare RL edge vs rule-based PnL |
| Live promotion | only after backtest | If RL beats rule-based by ≥X%, enable live execution |

Shadow keys live in Redis at `hermes:finrl:shadow:<ulid>` with 14-day TTL.

## Full Training (operator-driven, not in smoke test)

```bash
# Requires real journal data at HERMES_JOURNAL_PATH
HERMES_JOURNAL_PATH=/path/to/journal.jsonl \
python -m finrl_x.train
# → PPO + SAC ensemble, walk-forward validation, ONNX export
```
